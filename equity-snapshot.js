// equity-snapshot.js — the daily equity ledger (fase 1 of the financial report).
//
// One snapshot per wallet per UTC day, taken incrementally: the walk NEVER goes
// deeper than the previous snapshot (the zero-walk rule). Weekly/monthly/yearly
// reports (later phases) are pure arithmetic over these files — zero Helius
// calls at report time. This module is the ONLY sanctioned fetchAllTxs caller
// on the ledger path, and its stopBeforeSec is always derived from the previous
// snapshot — never from a constant, never from config.
//
// The ledger deliberately does NOT live under repoPath(): both daemons (and any
// future wallet) must write where one consolidator can read them, and a
// worktree checkout can disappear. Location: ~/.meridian/ledger/<address>/
// snapshots.json, overridable via MERIDIAN_LEDGER_DIR (unit tests) or
// config.report.ledgerDir.
//
// Snapshots are the raw material, not a report: nothing here sends anything.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { writeJsonAtomic, readJsonStore } from "./utils/json-store.js";
import {
  walletChange,
  classifyCashFlows,
  fetchAllTxs,
  fetchBalance,
  fetchSolPrice,
  fetchLlmUsage,
} from "./utils/chain-flows.js";

const DAY_MS = 24 * 3600 * 1000;

// How many overlap-lengths of window signatures each snapshot keeps for the
// next walk's dedup. Tomorrow's walk reaches down to (boundary − overlap), so
// only signatures inside that horizon can ever be re-fetched; 4× leaves margin
// for Helius page granularity (the final page can overshoot the cutoff).
const SIG_HORIZON_FACTOR = 4;

// A pnl_samples tick older than this is stale for the market memo. Suspicious
// ticks are never appended to the ring buffer (state.js), so "no fresh sample"
// is exactly the existing pnl_pct_suspicious signal surfacing here.
const MARKET_MEMO_STALE_MS = 15 * 60 * 1000;

const round9 = (v) => Math.round(v * 1e9) / 1e9;

// ─── time & paths ────────────────────────────────────────────────────

/** Epoch ms of 00:00:00Z on the UTC day containing `ts`. */
export function dayBoundaryUtc(ts = Date.now()) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Snapshot id (YYYY-MM-DD) for a boundary. */
export function snapshotIdFor(boundaryMs) {
  return new Date(boundaryMs).toISOString().slice(0, 10);
}

/**
 * Where the ledger lives. MERIDIAN_LEDGER_DIR wins (the unit-test suite points
 * it at a temp dir — the ledger bypasses repoPath(), so MERIDIAN_STATE_DIR
 * alone would not isolate it); otherwise config.report.ledgerDir with `~`
 * expanded. Resolved at call time, not module load, so tests that set the env
 * var before a dynamic import are always honored.
 */
export function resolveLedgerDir() {
  if (process.env.MERIDIAN_LEDGER_DIR) return path.resolve(process.env.MERIDIAN_LEDGER_DIR);
  const dir = config.report?.ledgerDir || "~/.meridian/ledger";
  return path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
}

function ledgerFileFor(address) {
  return path.join(resolveLedgerDir(), address, "snapshots.json");
}

// ─── store ───────────────────────────────────────────────────────────

/**
 * Read a wallet's snapshot ledger. Missing file → empty ledger (legitimate
 * first run). Existing-but-unparseable file THROWS (readJsonStore) — never
 * swallow a parse error and write an empty structure back over real history.
 */
export function loadSnapshots(address) {
  return readJsonStore(ledgerFileFor(address), { version: 1, address, snapshots: [] });
}

function saveSnapshots(address, store) {
  const file = ledgerFileFor(address);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep the array ordered by id — consumers binary-search / take the tail.
  store.snapshots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeJsonAtomic(file, store);
}

/**
 * Latest snapshot whose boundary is at or before `when` (a YYYY-MM-DD id, an
 * ISO string, or epoch ms). Pure lookup — zero network.
 */
export function snapshotAtOrBefore(snapshots, when) {
  const target =
    typeof when === "number"
      ? when
      : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(when)) ? `${when}T00:00:00Z` : when);
  if (!Number.isFinite(target)) throw new Error(`snapshotAtOrBefore: batas tidak valid: "${when}"`);
  let found = null;
  for (const s of snapshots) {
    if (Date.parse(s.boundary_ts) <= target) found = s;
    else break;
  }
  return found;
}

// ─── read-only inputs (state.json / lessons.json / env) ──────────────

function getWalletAddress() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
}

function llmKeyId() {
  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) return null;
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 8);
}

function readStatePositions() {
  const state = readJsonStore(repoPath("state.json"), { positions: {} });
  return Object.values(state.positions || {});
}

function readPerformanceEntries() {
  // performance = the live era; performance_archive = reconstructed closes of
  // wiped eras (scripts/backfill-era.mjs). Both are dated by recorded_at, so a
  // daily window can rollup across the union safely.
  const lessons = readJsonStore(repoPath("lessons.json"), {});
  return [...(lessons.performance || []), ...(lessons.performance_archive || [])];
}

/**
 * Tracked positions that were open AT the boundary instant: deployed before it
 * and not closed until at or after it. Dry (paper) positions never carry real
 * capital and are excluded.
 */
function positionsOpenAt(positions, boundaryMs) {
  return positions.filter((p) => {
    if (p.dry) return false;
    const deployed = Date.parse(p.deployed_at);
    if (!Number.isFinite(deployed) || deployed >= boundaryMs) return false;
    if (!p.closed) return true;
    const closed = Date.parse(p.closed_at);
    return Number.isFinite(closed) && closed >= boundaryMs;
  });
}

/**
 * Rent held by the open positions' accounts, read live via RPC getBalance —
 * the account's lamports ARE the rent that comes back at close, so this is
 * at-cost by construction, needs no history, and never touches the Helius
 * enhanced API. A position that closed between the boundary and now has no
 * account left (getBalance → 0/throw): its rent is skipped for that one entry
 * and the ~0.06–0.11 SOL blip self-corrects on the next snapshot.
 */
async function fetchPositionsRentSol(positions) {
  let rent = 0;
  for (const p of positions) {
    try {
      rent += await fetchBalance(p.position);
    } catch {
      // account gone or RPC hiccup — absorbed into the memo, never fatal
    }
  }
  return round9(rent);
}

/**
 * Market value memo from the PnL poller's own tick trace (state.json
 * pnl_samples — trusted ticks only, appended every ~3s while the daemon runs).
 * Read-only on purpose: getMyPositions() writes OOR marks into state.json, and
 * this code also runs from a one-shot script next to a live daemon — two
 * writers on state.json is the 18 Aug 2026 incident all over again.
 */
function marketMemoFor(positions, nowMs) {
  if (!positions.length) return { nilai_pasar_sol: 0, suspect: false };
  let value = 0;
  let suspect = false;
  for (const p of positions) {
    const samples = Array.isArray(p.pnl_samples) ? p.pnl_samples : [];
    const last = samples.length ? samples[samples.length - 1] : null;
    const at = last ? Date.parse(last.t) : NaN;
    if (last && Number.isFinite(last.p) && Number.isFinite(at) && nowMs - at <= MARKET_MEMO_STALE_MS) {
      value += (p.amount_sol || 0) * (1 + last.p / 100);
    } else {
      value += p.amount_sol || 0; // cost as placeholder; flagged below
      suspect = true;
    }
  }
  return { nilai_pasar_sol: round9(value), suspect };
}

// ─── the pure assembler ──────────────────────────────────────────────

/**
 * Assemble one snapshot entry (§07 of the design) from already-gathered
 * inputs. Pure — no network, no filesystem — so the unit suite can assert the
 * sign conventions and the zero-walk rule without stubbing the world.
 *
 * `window_sigs` is the one deliberate addition to the §07 shape: the window's
 * tx signatures inside the overlap re-fetch horizon. Tomorrow's walk overlaps
 * 30 minutes back into this window, and signature dedup against THIS list is
 * what makes that overlap free instead of double-counted.
 */
export function buildWindowSnapshot({
  id,
  boundaryMs,
  takenAtIso,
  source, // "light" | "derived" | "genesis"
  wallet,
  windowTxs = [],
  saldoBebasSol,
  positions = [],
  rentSol = 0,
  marketMemo = null,
  bookEntries = [],
  solPrice = null,
  llmUsdLifetime = null,
  llmKeyIdVal = null,
  prevSaldoBebasSol = null,
  driftToleranceSol = 0.001,
  overlapSec = 1800,
  walkReachedCutoff = true,
  trustedOverride = null,
}) {
  const flows = classifyCashFlows(windowTxs, wallet);

  // Book rollup. Wins follow the repo convention (pnl_usd >= 0, pnl-report.js).
  // Fee LP: native SOL where recorded (fees_earned_sol exists from 3 Aug 2026
  // on), current-price conversion for the rest — same mix as /pnl.
  let wins = 0, feeSolNative = 0, feeUsdNoSol = 0, netRevSol = 0, liqGapSol = 0;
  for (const e of bookEntries) {
    if ((e.pnl_usd || 0) >= 0) wins++;
    if (Number.isFinite(e.fees_earned_sol)) feeSolNative += e.fees_earned_sol;
    else feeUsdNoSol += e.fees_earned_usd || 0;
    if (Number.isFinite(e.pnl_sol)) netRevSol += e.pnl_sol;
    const gap = e.exit_execution?.liquidation_gap_sol;
    if (Number.isFinite(gap)) liqGapSol += gap;
  }
  const feeLpSol = feeSolNative + (solPrice > 0 ? feeUsdNoSol / solPrice : 0);

  const principalSol = round9(positions.reduce((s, p) => s + (p.amount_sol || 0), 0));
  const modalPosisiSol = round9(principalSol + rentSol);
  const totalSol = round9(saldoBebasSol + modalPosisiSol);

  const flowSumSol = round9(windowTxs.reduce((s, t) => s + walletChange(t, wallet), 0));
  const deltaBalanceSol =
    prevSaldoBebasSol != null ? round9(saldoBebasSol - prevSaldoBebasSol) : null;
  const driftSol = deltaBalanceSol != null ? round9(deltaBalanceSol - flowSumSol) : null;
  const trusted =
    trustedOverride != null
      ? trustedOverride
      : walkReachedCutoff && (driftSol == null || Math.abs(driftSol) <= driftToleranceSol);

  const boundarySec = boundaryMs / 1000;
  const sigHorizonSec = boundarySec - SIG_HORIZON_FACTOR * overlapSec;
  const windowSigs = windowTxs
    .filter((t) => t.timestamp >= sigHorizonSec)
    .map((t) => t.signature);

  return {
    id,
    boundary_ts: new Date(boundaryMs).toISOString().replace(".000Z", "Z"),
    taken_at: takenAtIso,
    source,
    equity: {
      saldo_bebas_sol: round9(saldoBebasSol),
      modal_posisi_sol: modalPosisiSol,
      principal_sol: principalSol,
      rent_sol: round9(rentSol),
      total_sol: totalSol,
    },
    market_memo: marketMemo,
    flows: {
      deposit_in_sol: round9(flows.depositIn),
      withdraw_out_sol: round9(flows.withdrawOut),
      gas_sol: round9(flows.gasSol),
      gas_txn: flows.gasTxn,
      transfers: flows.transfers,
    },
    book: {
      closed: bookEntries.length,
      wins,
      fee_lp_sol: round9(feeLpSol),
      net_revenue_sol: round9(netRevSol),
      liquidation_gap_sol: round9(liqGapSol),
    },
    sol_price: solPrice,
    llm_usd_lifetime: llmUsdLifetime,
    llm_key_id: llmKeyIdVal,
    integrity: {
      delta_balance_sol: deltaBalanceSol,
      flow_sum_sol: flowSumSol,
      drift_sol: driftSol,
      trusted,
      txs: windowTxs.length,
    },
    window_sigs: windowSigs,
  };
}

// ─── takeSnapshot ────────────────────────────────────────────────────

function bookEntriesIn(perf, fromMs, toMs) {
  return perf.filter((e) => {
    const at = Date.parse(e.recorded_at);
    return Number.isFinite(at) && at >= fromMs && at < toMs;
  });
}

/**
 * Take the daily snapshot: window exactly [yesterday 00:00Z, today 00:00Z).
 * Idempotent — if today's entry exists it is returned untouched (the cron, the
 * watchdog, and a manual run may all fire on the same day). If the daemon was
 * down for N days, the same single walk also backfills the missed boundaries
 * as `source: "derived", trusted: false` entries (SOL-native only — historical
 * SOL prices cannot be recovered), then writes today's `"light"` entry.
 */
export async function takeSnapshot({ now = Date.now() } = {}) {
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not set");
  if (!process.env.RPC_URL) throw new Error("RPC_URL not set");
  const wallet = getWalletAddress();
  const store = loadSnapshots(wallet);
  const todayBoundary = dayBoundaryUtc(now);
  const todayId = snapshotIdFor(todayBoundary);
  const takenAtIso = new Date(now).toISOString();

  const existing = store.snapshots.find((s) => s.id === todayId);
  if (existing) return { written: [], skipped: todayId, snapshot: existing };

  const overlapSec = Math.max(0, Number(config.report.walkOverlapMin ?? 30)) * 60;
  const driftTol = Number(config.report.driftToleranceSol ?? 0.001);
  const positionsAll = readStatePositions();
  const perf = readPerformanceEntries();
  const solPrice = await fetchSolPrice().catch(() => null); // memo only — never fatal
  const llmUsd = await fetchLlmUsage();
  const keyId = llmKeyId();
  const prev = store.snapshots.length ? store.snapshots[store.snapshots.length - 1] : null;

  const common = {
    wallet,
    takenAtIso,
    driftToleranceSol: driftTol,
    overlapSec,
    llmKeyIdVal: keyId,
  };

  if (!prev) {
    // Genesis: the ledger starts here — there is no previous snapshot and no
    // window to compute. The only walk is [today's boundary → now] (typically
    // one page), just to pin the balance back to 00:00Z; stopBeforeSec is
    // derived from the very boundary being written, the single case where no
    // previous snapshot exists. July–August history is fase 6's seed script.
    const walk = await fetchAllTxs(wallet, process.env.HELIUS_API_KEY, {
      stopBeforeSec: Math.floor(todayBoundary / 1000),
    });
    const balanceNow = await fetchBalance(wallet);
    const postTxs = walk.txs.filter((t) => t.timestamp >= todayBoundary / 1000);
    const saldoBebas = round9(balanceNow - postTxs.reduce((s, t) => s + walletChange(t, wallet), 0));
    const positions = positionsOpenAt(positionsAll, todayBoundary);
    const entry = buildWindowSnapshot({
      ...common,
      id: todayId,
      boundaryMs: todayBoundary,
      source: "genesis",
      windowTxs: [],
      saldoBebasSol: saldoBebas,
      positions,
      rentSol: await fetchPositionsRentSol(positions),
      marketMemo: marketMemoFor(positions, now),
      bookEntries: [],
      solPrice,
      llmUsdLifetime: llmUsd,
      trustedOverride: true, // nothing to cross-check yet — the chain starts here
    });
    store.snapshots.push(entry);
    saveSnapshots(wallet, store);
    log("ledger", `Snapshot genesis ${todayId} tertulis — saldo bebas ${entry.equity.saldo_bebas_sol} SOL, total ${entry.equity.total_sol} SOL`);
    return { written: [todayId], snapshot: entry };
  }

  // ── incremental walk, anchored on the previous snapshot ──
  const prevBoundaryMs = Date.parse(prev.boundary_ts);
  const stopBeforeSec = Math.floor(prevBoundaryMs / 1000) - overlapSec;
  const walk = await fetchAllTxs(wallet, process.env.HELIUS_API_KEY, { stopBeforeSec });
  const balanceNow = await fetchBalance(wallet);

  // Client-side signature dedup against the previous snapshot. fetchAllTxs's
  // `known` short-circuit is deliberately NOT used: it stops at the FIRST
  // (newest) known signature, and a late-indexed tx with an older blocktime
  // sits deeper in the page order — the 30-minute overlap exists precisely to
  // catch those, and `known` would hide them.
  const prevSigs = new Set(prev.window_sigs || []);
  const freshTxs = walk.txs.filter(
    (t) => t.timestamp >= stopBeforeSec && !prevSigs.has(t.signature),
  );

  // Boundaries to write: every missed day, then today. A late-indexed tx from
  // before the previous boundary joins the FIRST new window — misdated by a
  // few minutes, but conserved; dropping it would be a permanent hole that
  // only a full re-walk could find.
  const boundaries = [];
  for (let b = prevBoundaryMs + DAY_MS; b <= todayBoundary; b += DAY_MS) boundaries.push(b);

  const written = [];
  let prevSaldo = prev.equity?.saldo_bebas_sol ?? null;
  let lastEntry = null;
  for (const boundaryMs of boundaries) {
    const isToday = boundaryMs === todayBoundary;
    const isFirst = boundaryMs === boundaries[0];
    const windowStartSec = (boundaryMs - DAY_MS) / 1000;
    // The first new window has no lower ts bound: a late-indexed tx from the
    // overlap region (blocktime before the previous boundary, missed by the
    // previous walk) lands here — misdated by minutes, but conserved.
    const windowTxs = freshTxs.filter(
      (t) => t.timestamp < boundaryMs / 1000 && (isFirst || t.timestamp >= windowStartSec),
    );
    // Balance AT this boundary, derived from the current balance minus every
    // flow that happened after it (the applyCutoff trick, per window): the
    // cron runs at 00:05 but the number belongs to 00:00.
    const saldoBebas = round9(
      balanceNow -
        freshTxs
          .filter((t) => t.timestamp >= boundaryMs / 1000)
          .reduce((s, t) => s + walletChange(t, wallet), 0),
    );
    const positions = positionsOpenAt(positionsAll, boundaryMs);
    const entry = buildWindowSnapshot({
      ...common,
      id: snapshotIdFor(boundaryMs),
      boundaryMs,
      source: isToday ? "light" : "derived",
      windowTxs,
      saldoBebasSol: saldoBebas,
      positions,
      rentSol: await fetchPositionsRentSol(positions),
      // Historical market value is unrecoverable for a missed day.
      marketMemo: isToday
        ? marketMemoFor(positions, now)
        : { nilai_pasar_sol: null, suspect: true },
      bookEntries: bookEntriesIn(perf, boundaryMs - DAY_MS, boundaryMs),
      solPrice: isToday ? solPrice : null, // derived entries are SOL-native only
      llmUsdLifetime: isToday ? llmUsd : null,
      prevSaldoBebasSol: prevSaldo,
      walkReachedCutoff: walk.reachedCutoff,
      trustedOverride: isToday ? null : false,
    });
    store.snapshots.push(entry);
    written.push(entry.id);
    prevSaldo = entry.equity.saldo_bebas_sol;
    lastEntry = entry;
  }

  saveSnapshots(wallet, store);
  const it = lastEntry.integrity;
  log(
    "ledger",
    `Snapshot ${written.join(", ")} tertulis — drift ${it.drift_sol ?? "n/a"} SOL, trusted=${it.trusted}, tx window=${it.txs}`,
  );
  return { written, snapshot: lastEntry };
}

// ─── gap healing ─────────────────────────────────────────────────────

/** Daily ids missing between the first and last snapshot, within [from, to). */
export function findMissingIds(snapshots, fromMs = null, toMs = null) {
  if (snapshots.length < 2) return [];
  const have = new Set(snapshots.map((s) => s.id));
  const first = Date.parse(snapshots[0].boundary_ts);
  const last = Date.parse(snapshots[snapshots.length - 1].boundary_ts);
  const lo = fromMs != null ? Math.max(first, dayBoundaryUtc(fromMs)) : first;
  const hi = toMs != null ? Math.min(last, dayBoundaryUtc(toMs)) : last;
  const missing = [];
  for (let b = lo + DAY_MS; b < hi; b += DAY_MS) {
    const id = snapshotIdFor(b);
    if (!have.has(id)) missing.push(id);
  }
  return missing;
}

/**
 * Heal interior holes ONLY — days missing between two existing snapshots
 * (e.g. a ledger restored from backup). A tail gap (daemon down through today)
 * is takeSnapshot's job. Healed entries are `source: "derived",
 * trusted: false`, SOL-native only.
 *
 * The walk still anchors on the snapshot before the gap (never deeper), but
 * Helius pages newest-first, so reaching an old gap costs paging down from the
 * present. The 6-hour watchdog keeps gaps young, so in practice this is small.
 */
export async function healGap(from = null, to = null) {
  const wallet = getWalletAddress();
  const store = loadSnapshots(wallet);
  const parseEdge = (v) => {
    if (v == null) return null;
    const ms =
      typeof v === "number"
        ? v
        : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? `${v}T00:00:00Z` : v);
    if (!Number.isFinite(ms)) throw new Error(`healGap: batas tidak valid: "${v}"`);
    return ms;
  };
  const missing = findMissingIds(store.snapshots, parseEdge(from), parseEdge(to));
  if (!missing.length) return { written: [] }; // detection is pure — no walk, no env needed
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not set");
  if (!process.env.RPC_URL) throw new Error("RPC_URL not set");

  const overlapSec = Math.max(0, Number(config.report.walkOverlapMin ?? 30)) * 60;
  const driftTol = Number(config.report.driftToleranceSol ?? 0.001);
  const positionsAll = readStatePositions();
  const perf = readPerformanceEntries();
  const keyId = llmKeyId();
  const takenAtIso = new Date().toISOString();

  // Anchor: the snapshot immediately before the oldest hole. stopBeforeSec is
  // derived from it — the zero-walk rule holds even while healing.
  const oldestHoleMs = Date.parse(`${missing[0]}T00:00:00Z`);
  const anchorBefore = snapshotAtOrBefore(store.snapshots, oldestHoleMs - DAY_MS);
  if (!anchorBefore) throw new Error("healGap: tidak ada snapshot sebelum gap — ini kasus genesis/seed, bukan heal");
  const stopBeforeSec = Math.floor(Date.parse(anchorBefore.boundary_ts) / 1000) - overlapSec;
  const walk = await fetchAllTxs(wallet, process.env.HELIUS_API_KEY, { stopBeforeSec });
  const anchorSigs = new Set(anchorBefore.window_sigs || []);

  const written = [];
  for (const id of missing) {
    const boundaryMs = Date.parse(`${id}T00:00:00Z`);
    // The balance anchor is the first snapshot AFTER the hole, walked backward:
    // saldo(boundary) = saldo(after) − flows in [boundary, after).
    const after = store.snapshots.find((s) => Date.parse(s.boundary_ts) > boundaryMs);
    if (!after) break; // tail gap — takeSnapshot's territory
    const afterMs = Date.parse(after.boundary_ts);
    const between = walk.txs.filter(
      (t) => t.timestamp >= boundaryMs / 1000 && t.timestamp < afterMs / 1000 && !anchorSigs.has(t.signature),
    );
    const saldoBebas = round9(
      (after.equity?.saldo_bebas_sol ?? 0) - between.reduce((s, t) => s + walletChange(t, wallet), 0),
    );
    const windowTxs = walk.txs.filter(
      (t) =>
        t.timestamp >= (boundaryMs - DAY_MS) / 1000 &&
        t.timestamp < boundaryMs / 1000 &&
        !anchorSigs.has(t.signature),
    );
    const beforeEntry = snapshotAtOrBefore(store.snapshots, boundaryMs - DAY_MS);
    const positions = positionsOpenAt(positionsAll, boundaryMs);
    const entry = buildWindowSnapshot({
      wallet,
      takenAtIso,
      driftToleranceSol: driftTol,
      overlapSec,
      llmKeyIdVal: keyId,
      id,
      boundaryMs,
      source: "derived",
      windowTxs,
      saldoBebasSol: saldoBebas,
      positions,
      rentSol: await fetchPositionsRentSol(positions),
      marketMemo: { nilai_pasar_sol: null, suspect: true },
      bookEntries: bookEntriesIn(perf, boundaryMs - DAY_MS, boundaryMs),
      solPrice: null, // historical price unrecoverable — SOL-native only
      llmUsdLifetime: null,
      prevSaldoBebasSol: beforeEntry?.equity?.saldo_bebas_sol ?? null,
      walkReachedCutoff: walk.reachedCutoff,
      trustedOverride: false,
    });
    store.snapshots.push(entry);
    store.snapshots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    written.push(id);
  }

  if (written.length) {
    saveSnapshots(wallet, store);
    log("ledger", `healGap: ${written.length} window bolong disembuhkan (${written.join(", ")}) — source=derived, trusted=false`);
  }
  return { written };
}
