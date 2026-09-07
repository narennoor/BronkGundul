// pnl-reconciler.js — async reconciliation of closed-position bookkeeping
// against the Meteora datapi once records have settled.
//
// Why: closePosition() only waits ~30s for dlmm.datapi to index a close. On
// fast-moving tokens the record is missing or half-settled (withdrawals ==
// deposits placeholder), so the performance entry is booked at 0 or at a
// stale valuation. This module re-fetches status=closed records afterwards
// and patches lessons.json (and the matching pool-memory deploy row) with
// the settled values. Runs from a cron in index.js and from
// scripts/reconcile-pnl.mjs for historical backfill.

import fs from "fs";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { evaluateCashMismatch } from "./tools/wallet.js";
import { writeJsonAtomic } from "./utils/json-store.js";
import { activeRpcUrl, rpcConnectionConfig } from "./utils/helius-keys.js";

const SETTLE_GRACE_MINUTES = 10;  // closes younger than this are still the close path's job
const GIVE_UP_HOURS = 72;         // flag entries the API never returned so we stop refetching
const REQUEST_DELAY_MS = 300;
const MAX_PAGES_PER_POOL = 5;
const MIN_PATCH_DELTA_USD = 0.02;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(repoPath(file), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  writeJsonAtomic(repoPath(file), data);
}

function num(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function getWalletAddress() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
}

async function fetchClosedEntries(pool, walletAddr, wanted) {
  const found = {};
  for (let page = 1; page <= MAX_PAGES_PER_POOL; page++) {
    const url = `https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${walletAddr}&status=closed&pageSize=100&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`datapi ${res.status} for pool ${pool.slice(0, 8)}`);
    const data = await res.json();
    const positions = data.positions || [];
    for (const p of positions) {
      if (wanted.has(p.positionAddress)) found[p.positionAddress] = p;
    }
    if (positions.length < 100 || Object.keys(found).length === wanted.size) break;
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }
  return found;
}

// Mirror of the closePosition/recordPerformance bookkeeping formulas.
function settledValues(posEntry) {
  const finalUsd = num(posEntry.allTimeWithdrawals?.total?.usd) ?? 0;
  const initialUsd = num(posEntry.allTimeDeposits?.total?.usd) ?? 0;
  const feesUsd = num(posEntry.allTimeFees?.total?.usd) ?? 0;
  const pnlUsd = Math.round(((finalUsd + feesUsd) - initialUsd) * 100) / 100;
  const pnlPct = initialUsd > 0 ? Math.round((pnlUsd / initialUsd) * 10000) / 100 : 0;
  const pnlSol = num(posEntry.pnlSol) ?? num(posEntry.pnl?.valueNative);
  return { finalUsd, initialUsd, feesUsd, pnlUsd, pnlPct, pnlSol };
}

/**
 * Re-fetch settled closed-PnL records and patch bookkeeping.
 * @param {object} opts
 * @param {number} opts.lookbackHours - how far back to scan performance entries
 * @param {boolean} opts.force - re-check entries already flagged reconciled
 * @param {boolean} opts.dryRun - report what would change without writing
 */
export async function reconcileClosedPnl({ lookbackHours = 48, force = false, dryRun = false } = {}) {
  const walletAddr = getWalletAddress();
  const data = readJson("lessons.json", null);
  if (!data?.performance?.length) return { checked: 0, patched: 0, flagged: 0 };

  const now = Date.now();
  const cutoff = now - lookbackHours * 3600_000;
  const graceEdge = now - SETTLE_GRACE_MINUTES * 60_000;

  const candidates = data.performance.filter((p) => {
    if (!p.position || !p.pool || !p.recorded_at) return false;
    const t = new Date(p.recorded_at).getTime();
    if (!Number.isFinite(t) || t < cutoff || t > graceEdge) return false;
    return force || !p.pnl_reconciled;
  });
  if (!candidates.length) return { checked: 0, patched: 0, flagged: 0 };

  // Group by pool so each pool is one (paged) fetch.
  const byPool = new Map();
  for (const p of candidates) {
    if (!byPool.has(p.pool)) byPool.set(p.pool, new Set());
    byPool.get(p.pool).add(p.position);
  }

  const fetched = {};
  for (const [pool, wanted] of byPool) {
    try {
      Object.assign(fetched, await fetchClosedEntries(pool, walletAddr, wanted));
    } catch (e) {
      log("reconcile_warn", e.message);
    }
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  // Reload fresh before writing — a close may have landed while we fetched.
  const fresh = readJson("lessons.json", null);
  if (!fresh?.performance?.length) return { checked: candidates.length, patched: 0, flagged: 0 };

  const patches = [];
  let flagged = 0;
  for (const entry of fresh.performance) {
    if (!candidates.some((c) => c.position === entry.position && c.recorded_at === entry.recorded_at)) continue;
    const posEntry = fetched[entry.position];
    const ageHours = (now - new Date(entry.recorded_at).getTime()) / 3600_000;

    if (!posEntry) {
      if (ageHours > GIVE_UP_HOURS) { entry.pnl_reconciled = "not_found"; flagged++; }
      continue;
    }

    const v = settledValues(posEntry);
    if (v.finalUsd <= 0) continue; // withdraw not indexed yet — retry next run

    // Same anti-outlier stance as recordPerformance: never adopt an absurd
    // non-stop-loss wipeout from a possibly still-degenerate record.
    const reasonText = String(entry.close_reason || "").toLowerCase();
    if (v.pnlPct <= -90 && !reasonText.includes("stop loss")) {
      entry.pnl_reconciled = "skipped_absurd";
      flagged++;
      continue;
    }

    const delta = v.pnlUsd - (entry.pnl_usd || 0);
    if (Math.abs(delta) > MIN_PATCH_DELTA_USD) {
      entry.pre_reconcile = {
        pnl_usd: entry.pnl_usd ?? null,
        pnl_pct: entry.pnl_pct ?? null,
        fees_earned_usd: entry.fees_earned_usd ?? null,
        final_value_usd: entry.final_value_usd ?? null,
        initial_value_usd: entry.initial_value_usd ?? null,
      };
      entry.pnl_usd = v.pnlUsd;
      entry.pnl_pct = v.pnlPct;
      entry.fees_earned_usd = Math.round(v.feesUsd * 10000) / 10000;
      entry.final_value_usd = v.finalUsd;
      entry.initial_value_usd = v.initialUsd;
      patches.push({ position: entry.position, pool: entry.pool, recorded_at: entry.recorded_at, delta, pnl_usd: v.pnlUsd, pnl_pct: v.pnlPct, fees_earned_usd: entry.fees_earned_usd });
    }
    if (v.pnlSol != null) entry.pnl_sol = Math.round(v.pnlSol * 10000) / 10000;
    entry.pnl_reconciled = true;
    entry.reconciled_at = new Date(now).toISOString();
    flagged++;
  }

  if (!dryRun && flagged > 0) writeJson("lessons.json", fresh);
  if (!dryRun && patches.length > 0) patchPoolMemory(patches);

  const totalDelta = patches.reduce((s, p) => s + p.delta, 0);
  if (patches.length > 0 || flagged > 0) {
    log("reconcile", `Checked ${candidates.length} close(s): patched ${patches.length} (net ${totalDelta >= 0 ? "+" : ""}$${totalDelta.toFixed(2)}), flagged ${flagged}${dryRun ? " [DRY RUN]" : ""}`);
  }
  return { checked: candidates.length, patched: patches.length, flagged, totalDelta, patches };
}

// ─── Cash recheck (--recheck-cash) ──────────────────────────────
// Rebuilds sol_cycle_net for a closed position from the chain instead of from
// the signatures the close path happened to hand over.
//
// Why it can't just re-run reconcileCycleCash: that function measures the
// signatures it is given, and the whole failure being repaired here is that
// signatures went missing (a timed-out close tx unwound the function and took
// the already-landed signatures with it). So this walks the POSITION ACCOUNT's
// own signature history — every deploy, add, claim, remove and close tx touched
// that account, and nothing else did, so the set is both complete and free of
// other positions' traffic. The Jupiter swap leg is the one tx that never
// touches the position account, and it is already recorded on the entry as
// exit_execution.swap_tx.

function getRpcConnection() {
  const url = activeRpcUrl();
  if (!url) throw new Error("RPC_URL (or HELIUS_API_KEY) not set");
  return new Connection(url, rpcConnectionConfig("confirmed"));
}

async function allSignaturesForAddress(connection, address, { max = 1000 } = {}) {
  const out = [];
  let before = undefined;
  while (out.length < max) {
    const page = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 1000, before });
    if (!page?.length) break;
    for (const s of page) if (!s.err) out.push(s.signature);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }
  return out;
}

async function walletDeltaFor(connection, walletAddr, signature) {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  const msg = tx?.transaction?.message;
  const keys = msg?.staticAccountKeys || msg?.accountKeys || [];
  const idx = keys.findIndex((k) => k?.toString() === walletAddr);
  if (!tx?.meta || idx < 0) return null;
  return (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
}

const round9 = (n) => Math.round(n * 1e9) / 1e9;

/**
 * Does this performance entry's cash bookkeeping deserve a rescan?
 *
 * The verdict must be the SAME one the live close path applies
 * (evaluateCashMismatch), rent allowance included. The old inline filter here
 * flagged any |inflow − withdrawals| > 1% of deposit — but the position-account
 * rent refund (~0.109 SOL on a 135-bin position) exceeds 1% of every normal
 * 2-3 SOL deposit, so a no-args `--recheck-cash` run considered virtually every
 * healthy cycle suspect and set off rescanning hundreds of positions
 * (12 Aug 2026). Pure, exported for tests.
 */
export function isCashSuspect(entry, tolerancePct = Number(config.tx?.cashMismatchTolerancePct ?? 1)) {
  const x = entry?.exit_execution || {};
  // The live cross-check (or the sync-close path) already declared these
  // incomplete — always rescan-worthy, whatever the mismatch arithmetic says.
  if (x.cash_complete === false) return true;
  // A COMPLETE position-account scan is final: it measured every tx that ever
  // touched the account, so re-running it returns the same figure every time.
  // Without this, a close whose Meteora cross-check stays odd even after the
  // scan (LOUIE-SOL 11 Aug: surplus beyond one rent, scan-verified correct)
  // would be rescanned by every single default run, forever.
  if (x.cash_complete === true && String(x.cash_source || "").includes("position-account scan")) return false;
  const { over_tolerance } = evaluateCashMismatch({
    inflowSol: (x.sol_in_close ?? 0) + (x.sol_in_swap ?? 0),
    withdrawalsSol: entry?.withdrawals_sol,
    depositBasisSol: entry?.deposits_sol ?? entry?.amount_sol ?? 0,
    tolerancePct,
  });
  return over_tolerance;
}

/**
 * Recompute the on-chain cash figures for closed positions and patch
 * lessons.json.
 *
 * @param {object} opts
 * @param {string[]} opts.positions - position addresses to fix; empty = every
 *   entry inside `lookbackHours` whose books look suspect
 * @param {number} opts.lookbackHours
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.all - with no explicit positions, recheck every entry in
 *   the window instead of only the suspect ones
 */
export async function recheckCash({ positions = [], lookbackHours = 168, dryRun = false, all = false } = {}) {
  const walletAddr = getWalletAddress();
  const connection = getRpcConnection();
  const data = readJson("lessons.json", null);
  if (!data?.performance?.length) return { checked: 0, patched: 0, patches: [] };
  const state = readJson("state.json", { positions: {} });

  const wanted = new Set(positions.filter(Boolean));
  const cutoff = Date.now() - lookbackHours * 3600_000;
  const targets = data.performance.filter((p) => {
    if (!p.position) return false;
    if (wanted.size) return wanted.has(p.position);
    const t = new Date(p.recorded_at).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (all) return true;
    return isCashSuspect(p);
  });
  if (!targets.length) return { checked: 0, patched: 0, patches: [] };

  const results = new Map();
  for (const entry of targets) {
    try {
      const deploySigs = new Set(state.positions?.[entry.position]?.deploy_txs || []);
      const swapTx = entry.exit_execution?.swap_tx || null;
      const positionSigs = await allSignaturesForAddress(connection, entry.position);
      const sigs = [...new Set([...positionSigs, ...deploySigs, ...(swapTx ? [swapTx] : [])])];

      let outDeploy = 0, inClose = 0, inSwap = 0, found = 0, missing = 0;
      for (const sig of sigs) {
        const delta = await walletDeltaFor(connection, walletAddr, sig);
        if (delta == null) { missing++; continue; }
        found++;
        if (sig === swapTx) inSwap += delta;
        else if (deploySigs.has(sig)) outDeploy += delta;
        else inClose += delta;
        await new Promise((r) => setTimeout(r, 60));
      }

      results.set(entry.position, {
        position: entry.position,
        pool_name: entry.pool_name,
        recorded_at: entry.recorded_at,
        before: entry.exit_execution?.sol_cycle_net ?? null,
        cash: {
          sol_out_deploy: round9(outDeploy),
          sol_in_claim: 0, // claims land on the position account too; folded into close
          sol_in_close: round9(inClose),
          sol_in_swap: round9(inSwap),
          sol_cycle_net: round9(outDeploy + inClose + inSwap),
          cash_txs_found: found,
          cash_txs_missing: missing,
          cash_complete: missing === 0 && found > 0,
          cash_source: "recheck-cash (position-account scan)",
          cash_rechecked_at: new Date().toISOString(),
        },
      });
    } catch (e) {
      log("reconcile_warn", `recheck-cash failed for ${entry.position.slice(0, 8)}: ${e.message}`);
    }
  }

  // Reload fresh before writing — a live close may have landed meanwhile.
  const fresh = readJson("lessons.json", null);
  const patches = [];
  for (const entry of fresh?.performance || []) {
    const result = results.get(entry.position);
    if (!result || entry.recorded_at !== result.recorded_at) continue;
    const previous = entry.exit_execution || {};
    // A rescan supersedes whatever the live cross-check concluded, so its
    // verdict fields must not survive as stale leftovers next to fresh numbers.
    const { cash_mismatch_sol, cash_mismatch_direction, cash_mismatch_over_tolerance,
            cash_mismatch_tolerance_pct, ...carried } = previous;
    entry.exit_execution = {
      ...carried,
      ...result.cash,
      pre_recheck_cash: previous.pre_recheck_cash || {
        sol_out_deploy: previous.sol_out_deploy ?? null,
        sol_in_close: previous.sol_in_close ?? null,
        sol_in_swap: previous.sol_in_swap ?? null,
        sol_cycle_net: previous.sol_cycle_net ?? null,
        cash_complete: previous.cash_complete ?? null,
        cash_mismatch_sol: cash_mismatch_sol ?? null,
      },
    };
    patches.push({
      position: entry.position,
      pool_name: entry.pool_name,
      recorded_at: entry.recorded_at,
      before: result.before,
      after: result.cash.sol_cycle_net,
      delta: round9(result.cash.sol_cycle_net - (result.before ?? 0)),
      txs: result.cash.cash_txs_found,
    });
  }

  if (!dryRun && patches.length) writeJson("lessons.json", fresh);
  const totalDelta = round9(patches.reduce((s, p) => s + p.delta, 0));
  if (patches.length) {
    log("reconcile", `recheck-cash patched ${patches.length} close(s), net ${totalDelta >= 0 ? "+" : ""}${totalDelta} SOL${dryRun ? " [DRY RUN]" : ""}`);
  }
  return { checked: targets.length, patched: patches.length, patches, totalDelta };
}

// Same exclusion rule as pool-memory.isAdjustedWinRateExcludedReason (not exported).
function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

// Mirror the deploy rows + aggregate recompute in pool-memory.recordPoolDeploy.
function patchPoolMemory(patches) {
  const db = readJson("pool-memory.json", null);
  if (!db) return;
  let touched = false;

  for (const patch of patches) {
    const entry = db[patch.pool];
    if (!entry?.deploys?.length) continue;
    const row = entry.deploys.find((d) => d.closed_at === patch.recorded_at);
    if (!row) continue;
    row.pnl_usd = patch.pnl_usd;
    row.pnl_pct = patch.pnl_pct;
    if (patch.fees_earned_usd != null) row.fees_earned_usd = patch.fees_earned_usd;
    touched = true;

    const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
    if (withPnl.length > 0) {
      entry.avg_pnl_pct = Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100;
      entry.win_rate = Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100;
    }
    const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
    entry.adjusted_win_rate_sample_count = adjusted.length;
    entry.adjusted_win_rate = adjusted.length > 0
      ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
      : 0;
    if (withPnl.length > 0) {
      const lastRow = entry.deploys[entry.deploys.length - 1];
      entry.last_outcome = (lastRow.pnl_pct ?? 0) >= 0 ? "profit" : "loss";
    }
  }

  if (touched) writeJson("pool-memory.json", db);
}
