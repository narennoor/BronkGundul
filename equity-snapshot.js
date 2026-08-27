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

/** This daemon's wallet address — the ledger key. Exported for financial-report.js. */
export function ledgerWalletAddress() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
}
const getWalletAddress = ledgerWalletAddress;

function llmKeyId() {
  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) return null;
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 8);
}

function readStatePositions() {
  const state = readJsonStore(repoPath("state.json"), { positions: {} });
  return Object.values(state.positions || {});
}

export function readPerformanceEntries() {
  // performance = the live era; performance_archive = reconstructed closes of
  // wiped eras (scripts/backfill-era.mjs). Both are dated by recorded_at, so a
  // daily window can rollup across the union safely. Exported for
  // financial-csv.js (closes CSV) — same source, same recorded_at dating, so
  // its rows always reconcile with the seals' pnl.closes.
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

// ─── periods: seal mingguan / bulanan (fase 2) ───────────────────────
//
// A seal is the immutable close of one calendar period, folded PURELY from the
// daily snapshots — zero Helius calls, zero RPC, files only. Chains run PER
// KIND: week seals chain to week seals, month to month; monthly numbers are
// always folded straight from daily snapshots, never from weekly sums (ISO
// weeks cross month boundaries).

const WEEK_MS = 7 * DAY_MS;

const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

function isoWeek1Monday(year) {
  // ISO-8601: week 1 is the week containing Jan 4.
  const jan4 = Date.UTC(year, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7; // 0 = Monday
  return jan4 - dow * DAY_MS;
}

/** ISO week id (YYYY-Www) of the UTC day containing `ts`. */
export function isoWeekIdFor(ts) {
  const d = dayBoundaryUtc(ts);
  const monday = d - ((new Date(d).getUTCDay() + 6) % 7) * DAY_MS;
  const year = new Date(monday + 3 * DAY_MS).getUTCFullYear(); // the Thursday decides
  const week = Math.round((monday - isoWeek1Monday(year)) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Half-open [from, to) bounds of a period id, pure UTC. */
export function periodBounds(kind, id) {
  if (kind === "week") {
    const m = /^(\d{4})-W(\d{2})$/.exec(String(id));
    if (!m) throw new Error(`id minggu tidak valid: "${id}" — format ISO YYYY-Www, mis. 2026-W35`);
    const from = isoWeek1Monday(Number(m[1])) + (Number(m[2]) - 1) * WEEK_MS;
    return { from, to: from + WEEK_MS };
  }
  if (kind === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(String(id));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      throw new Error(`id bulan tidak valid: "${id}" — format YYYY-MM, mis. 2026-08`);
    }
    return { from: Date.UTC(Number(m[1]), Number(m[2]) - 1, 1), to: Date.UTC(Number(m[1]), Number(m[2]), 1) };
  }
  if (kind === "year") {
    const m = /^(\d{4})$/.exec(String(id));
    if (!m) throw new Error(`id tahun tidak valid: "${id}" — format YYYY, mis. 2026`);
    return { from: Date.UTC(Number(m[1]), 0, 1), to: Date.UTC(Number(m[1]) + 1, 0, 1) };
  }
  throw new Error(`kind "${kind}" tidak dikenal — week | month | year`);
}

/** Period id containing `ts`. */
export function periodIdFor(kind, ts) {
  if (kind === "week") return isoWeekIdFor(ts);
  if (kind === "month") return new Date(dayBoundaryUtc(ts)).toISOString().slice(0, 7);
  if (kind === "year") return new Date(dayBoundaryUtc(ts)).toISOString().slice(0, 4);
  throw new Error(`kind "${kind}" tidak dikenal — week | month | year`);
}

/** Calendar-previous period id of the same kind. */
export function prevPeriodId(kind, id) {
  return periodIdFor(kind, periodBounds(kind, id).from - DAY_MS);
}

/** The most recent fully-closed period at `now` — the one the cron seals. */
export function lastClosedPeriodId(kind, now = Date.now()) {
  return prevPeriodId(kind, periodIdFor(kind, now));
}

function periodsFileFor(address) {
  return path.join(resolveLedgerDir(), address, "periods.json");
}

/** Read a wallet's sealed periods. Missing file → empty; corrupt → THROWS. */
export function loadPeriods(address) {
  return readJsonStore(periodsFileFor(address), { version: 1, address, periods: [] });
}

function savePeriods(address, store) {
  const file = periodsFileFor(address);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.periods.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.kind.localeCompare(b.kind),
  );
  writeJsonAtomic(file, store);
}

/**
 * The shared window fold: everything both a sealed period and the YTD preview
 * need from a snapshot range (from, to]. PURE — no network, no filesystem.
 * `opening`/`closing` are the EXACT boundary snapshots or null; callers decide
 * whether null is fatal (a seal: yes) or a labeled fallback (YTD preview).
 */
export function foldWindows(snapshots, from, to) {
  const opening = snapshots.find((s) => Date.parse(s.boundary_ts) === from) ?? null;
  const closing = snapshots.find((s) => Date.parse(s.boundary_ts) === to) ?? null;
  const win = snapshots.filter((s) => {
    const b = Date.parse(s.boundary_ts);
    return b > from && b <= to;
  });
  let dep = 0, wd = 0, gas = 0, feeLp = 0, netRev = 0, liqGap = 0, closes = 0, wins = 0;
  const timedFlows = []; // { ts(sec), sol(signed) } — exact timing for Dietz
  for (const s of win) {
    dep += s.flows.deposit_in_sol;
    wd += s.flows.withdraw_out_sol;
    gas += s.flows.gas_sol;
    feeLp += s.book.fee_lp_sol;
    netRev += s.book.net_revenue_sol;
    liqGap += s.book.liquidation_gap_sol;
    closes += s.book.closed;
    wins += s.book.wins;
    for (const t of s.flows.transfers || []) {
      timedFlows.push({ ts: t.ts, sol: t.dir === "in" ? t.amount_sol : -t.amount_sol });
    }
  }
  return {
    opening,
    closing,
    win,
    sums: { dep, wd, gas, feeLp, netRev, liqGap, closes, wins },
    timedFlows,
    allTrusted: win.length > 0 && win.every((s) => s.integrity?.trusted === true),
    cumDrift: round9(win.reduce((s, w) => s + (w.integrity?.drift_sol || 0), 0)),
  };
}

/**
 * TWR factor over one window range: chained daily sub-period returns, flows
 * treated as start-of-day, daily LLM lifetime diffs joining the numerator
 * where both endpoints of a day carry a same-key reading. Multiplicative and
 * associative — chaining monthly factors equals chaining daily ones (§04).
 */
export function chainDailyTwr(opening, win) {
  let factor = 1;
  let prevSnap = opening;
  for (const s of win) {
    const flowNet = s.flows.deposit_in_sol - s.flows.withdraw_out_sol;
    let llmDaySol = 0;
    if (
      Number.isFinite(prevSnap.llm_usd_lifetime) && Number.isFinite(s.llm_usd_lifetime) &&
      prevSnap.llm_key_id && prevSnap.llm_key_id === s.llm_key_id && s.sol_price > 0
    ) {
      llmDaySol = Math.max(0, s.llm_usd_lifetime - prevSnap.llm_usd_lifetime) / s.sol_price;
    }
    const base = prevSnap.equity.total_sol + flowNet;
    if (base > 1e-9) {
      factor *= 1 + (s.equity.total_sol - prevSnap.equity.total_sol - flowNet - llmDaySol) / base;
    }
    prevSnap = s;
  }
  return factor;
}

/**
 * LLM cost (USD, negative) between two endpoint snapshots: lifetime-reading
 * diff, valid only on the same key. USD is the ONLY representation that
 * telescopes across periods — month N's closing reading IS month N+1's
 * opening — which is why assertion 10 compares LLM in USD, never in SOL
 * (each month's llm_cost_sol is priced at its own closing price).
 */
export function llmEndpointDiffUsd(opening, closing) {
  if (
    Number.isFinite(opening?.llm_usd_lifetime) && Number.isFinite(closing?.llm_usd_lifetime) &&
    opening.llm_key_id && opening.llm_key_id === closing.llm_key_id
  ) {
    return -Math.round(Math.max(0, closing.llm_usd_lifetime - opening.llm_usd_lifetime) * 100) / 100;
  }
  return null;
}

// The additive pnl rows of a seal (§04 fold table) — the exact set assertion
// 10 sums across 12 monthly seals and compares to the yearly seal, and the
// YTD sigma check compares between its two computation lanes. llm_cost is
// deliberately NOT here (compared in USD, see llmEndpointDiffUsd); net_rill
// is excluded because it is gross_rill + llm_cost — both already covered.
export const ADDITIVE_PNL_ROWS = [
  "fee_lp_sol", "impermanent_loss_sol", "net_revenue_sol", "exec_cost_sol",
  "exec_cost_measured_sol", "gas_fee_sol", "gross_rill_sol", "closes", "wins",
];
export const ADDITIVE_EQUITY_ROWS = ["deposit_sol", "withdrawal_sol"];

/**
 * Fold one period record from the snapshot ledger. PURE — files already
 * loaded, no network, no filesystem. Exported for the unit suite and reused
 * (via foldWindows/chainDailyTwr) by the fase-3 YTD path.
 *
 * Assertion failures (§10) land in integrity.assertions_failed and flip
 * integrity.integrity_ok — they NEVER throw: a report with a label beats a
 * report that refuses to exist. What DOES throw is missing raw material:
 * sealing needs the exact opening and closing boundary snapshots, because a
 * seal is immutable and a substituted endpoint would bake a wrong number in
 * forever (the watchdog heals snapshots first, then seals).
 *
 * For kind "year", pass the year's monthly seals as `monthlySeals`: assertion
 * 10 sums their additive rows and compares against this record — two
 * independent computation lanes (daily snapshots vs monthly seals) that must
 * meet. There is deliberately NO weekly analogue: ISO weeks cross month and
 * year boundaries, so their sums never reconcile by construction.
 *
 * §07 shape plus four deliberate additions, all needed to keep sealed reports
 * self-contained once snapshots.json grows past them: pnl.closes, pnl.wins
 * (win_rate is recomputed, never summed), sol_price_close (the §09 CSV
 * column + USD derivation), integrity.integrity_ok.
 */
export function computePeriodRecord({
  kind,
  id,
  snapshots,
  prevSeal = null,
  prevSealExpected = false,
  monthlySeals = null,
  driftToleranceSol = 0.001,
  sealedAtIso = null,
}) {
  const { from, to } = periodBounds(kind, id);
  const assertions = [];
  const note = (s) => assertions.push(s);
  const eq = (x, y, tol = 1e-9) => Math.abs(x - y) <= tol;

  const fold = foldWindows(snapshots, from, to);
  const { opening, closing, win } = fold;
  if (!opening || !closing) {
    throw new Error(
      `Tidak bisa menyegel ${kind} ${id}: snapshot boundary ${!opening ? snapshotIdFor(from) : snapshotIdFor(to)} ` +
      `belum ada di ledger — jalankan snapshot/heal dulu (seal immutable, endpoint pengganti akan membekukan angka yang salah)`,
    );
  }
  const expected = Math.round((to - from) / DAY_MS);
  if (win.length !== expected) note(`windows:${win.length}/${expected} snapshot bolong`);

  // Everything signed in the record: pendapatan positif, biaya negatif.
  const depositSol = round9(fold.sums.dep);
  const withdrawalSol = round9(-fold.sums.wd);
  const gasFeeSol = round9(-fold.sums.gas);
  const feeLpSol = round9(fold.sums.feeLp);
  const netRevenueSol = round9(fold.sums.netRev);
  const ilSol = round9(netRevenueSol - feeLpSol); // IL is the residual after fees — signed, may be positive
  const { closes, wins } = fold.sums;

  // ── equity endpoints ──
  const saldoAwal = opening.equity.total_sol;
  const totalEkuitas = closing.equity.total_sol;
  const modalDasar = round9(saldoAwal + depositSol + withdrawalSol);
  const saldoBebas = closing.equity.saldo_bebas_sol;
  const modalPosisi = closing.equity.modal_posisi_sol;
  const labaKumulatif = round9(totalEkuitas - modalDasar);
  const grossRill = round9(totalEkuitas - saldoAwal - (depositSol + withdrawalSol));
  const execCost = round9(grossRill - netRevenueSol - gasFeeSol); // the plug row

  // ── LLM: lifetime reading diff between the endpoints, same key only ──
  const solPriceClose = Number.isFinite(closing.sol_price) ? closing.sol_price : null;
  const llmUsd = llmEndpointDiffUsd(opening, closing);
  const llmSol = llmUsd != null && solPriceClose > 0 ? round9(llmUsd / solPriceClose) : null;
  const netRill = round9(grossRill + (llmSol ?? 0));

  const mm = closing.market_memo || {};
  const unrealized = Number.isFinite(mm.nilai_pasar_sol) ? round9(mm.nilai_pasar_sol - modalPosisi) : null;

  // ── assertions 1–7 (§10). 1–6 are tautological when the code is right —
  // that is the point: they catch sign and rounding bugs. 7 is the sharp one. ──
  if (!eq(netRevenueSol, feeLpSol + ilSol)) note(`1:net_revenue ${netRevenueSol} != fee_lp+il ${round9(feeLpSol + ilSol)}`);
  if (!eq(grossRill, netRevenueSol + execCost + gasFeeSol)) note(`2:gross_rill ${grossRill} != net_revenue+exec+gas ${round9(netRevenueSol + execCost + gasFeeSol)}`);
  if (!eq(netRill, grossRill + (llmSol ?? 0))) note(`3:net_rill ${netRill} != gross_rill+llm ${round9(grossRill + (llmSol ?? 0))}`);
  if (!eq(modalDasar, saldoAwal + depositSol + withdrawalSol)) note(`4:modal_dasar ${modalDasar} != saldo_awal+deposit+withdrawal`);
  if (!eq(totalEkuitas, round9(saldoBebas + modalPosisi))) note(`5:total_ekuitas ${totalEkuitas} != saldo_bebas+modal_posisi ${round9(saldoBebas + modalPosisi)}`);
  if (!eq(labaKumulatif, grossRill, driftToleranceSol)) note(`6:laba_kumulatif ${labaKumulatif} != gross_rill ${grossRill}`);
  if (prevSeal) {
    if (!eq(saldoAwal, prevSeal.equity.total_ekuitas_sol)) {
      note(`7:saldo_awal ${saldoAwal} != total_ekuitas seal ${prevSeal.id} (${prevSeal.equity.total_ekuitas_sol}) — snapshot hilang atau seal tertimpa`);
    }
  } else if (prevSealExpected) {
    note(`7:seal ${prevPeriodId(kind, id)} tidak ada — rantai ${kind} putus`);
  }

  const record = {
    id,
    kind,
    prev_seal_id: prevSeal?.id ?? null,
    from: isoZ(from),
    to: isoZ(to),
    pnl: {
      fee_lp_sol: feeLpSol,
      impermanent_loss_sol: ilSol,
      net_revenue_sol: netRevenueSol,
      exec_cost_sol: execCost,
      exec_cost_measured_sol: round9(fold.sums.liqGap),
      gas_fee_sol: gasFeeSol,
      gross_rill_sol: grossRill,
      llm_cost_sol: llmSol,
      llm_cost_usd: llmUsd,
      net_rill_sol: netRill,
      closes,
      wins,
    },
    equity: {
      saldo_awal_sol: saldoAwal,
      deposit_sol: depositSol,
      withdrawal_sol: withdrawalSol,
      modal_dasar_sol: modalDasar,
      saldo_bebas_sol: saldoBebas,
      modal_posisi_sol: modalPosisi,
      modal_posisi_rent_sol: closing.equity.rent_sol,
      total_ekuitas_sol: totalEkuitas,
      laba_kumulatif_sol: labaKumulatif,
      unrealized_pnl_sol: unrealized,
      unrealized_suspect: !!mm.suspect,
    },
    roi: { dietz_pct: null, twr_pct: null },
    integrity: {
      windows: win.length,
      all_trusted: fold.allTrusted,
      cum_drift_sol: fold.cumDrift,
      integrity_ok: true, // finalized below
      assertions_failed: assertions,
    },
    sol_price_close: solPriceClose,
    sealed_at: sealedAtIso,
    snapshots_hash: crypto
      .createHash("sha256")
      .update(JSON.stringify([opening, ...win]))
      .digest("hex"),
  };

  // ── assertion 10 (year only): Σ 12 monthly seals == this record, additive
  // rows only. The two sides are computed on independent lanes on purpose. ──
  if (kind === "year" && monthlySeals) {
    const months = monthlySeals
      .filter((m) => m.kind === "month" && m.id.startsWith(`${id}-`))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (months.length) {
      const tol = Math.max(1e-6, driftToleranceSol);
      for (const row of ADDITIVE_PNL_ROWS) {
        const sum = round9(months.reduce((s, m) => s + (m.pnl[row] || 0), 0));
        if (!eq(sum, record.pnl[row], tol)) note(`10:${row} Σbulanan ${sum} != tahunan ${record.pnl[row]}`);
      }
      for (const row of ADDITIVE_EQUITY_ROWS) {
        const sum = round9(months.reduce((s, m) => s + (m.equity[row] || 0), 0));
        if (!eq(sum, record.equity[row], tol)) note(`10:${row} Σbulanan ${sum} != tahunan ${record.equity[row]}`);
      }
      // LLM in USD (the telescoping representation) — 12 per-month cent
      // roundings allow a few cents of slack.
      if (llmUsd != null) {
        const sumUsd = Math.round(months.reduce((s, m) => s + (m.pnl.llm_cost_usd || 0), 0) * 100) / 100;
        if (!eq(sumUsd, llmUsd, 0.15)) note(`10:llm_cost_usd Σbulanan ${sumUsd} != tahunan ${llmUsd}`);
      }
    }
    if (months.length < 12) note(`10:seal bulanan ${months.length}/12 — verifikasi silang parsial`);
  }

  // ── ROI ──
  // Modified Dietz over TOTAL equity, flows weighted by their exact timestamps
  // (flows.transfers[] — this is why per-transfer ts is recorded at snapshot
  // time). Numerator is Net Rill: LLM is a real operating cost.
  const spanMs = to - from;
  let weighted = 0;
  for (const f of fold.timedFlows) {
    const w = Math.min(1, Math.max(0, (to - f.ts * 1000) / spanMs));
    weighted += w * f.sol;
  }
  const dietzBase = saldoAwal + weighted;
  record.roi.dietz_pct = dietzBase > 1e-9 ? Math.round((netRill / dietzBase) * 10000) / 100 : null;
  record.roi.twr_pct = Math.round((chainDailyTwr(opening, win) - 1) * 10000) / 100;

  record.integrity.integrity_ok = assertions.length === 0;
  return record;
}

/**
 * Seal one closed period. THROWS if the id is already sealed — a seal is
 * immutable, and a cron bug must never silently rewrite August (§10). Pass
 * `{ reseal: true }` ONLY from an explicit operator action (--reseal).
 * Pure arithmetic over local files: zero Helius, zero RPC.
 */
export function sealPeriod(kind, id, { reseal = false, now = Date.now() } = {}) {
  const wallet = getWalletAddress();
  const { from, to } = periodBounds(kind, id); // validates kind + id
  if (to > now) {
    throw new Error(`${kind} ${id} belum tutup (batasnya ${isoZ(to)}) — periode berjalan tidak disegel`);
  }
  const store = loadPeriods(wallet);
  const existing = store.periods.find((p) => p.kind === kind && p.id === id);
  if (existing && !reseal) {
    throw new Error(
      `Seal ${kind} ${id} sudah ada (sealed_at ${existing.sealed_at}) — seal immutable. ` +
      `Pakai --reseal hanya kalau memang sengaja menimpa`,
    );
  }

  const snapshots = loadSnapshots(wallet).snapshots;
  const prevId = prevPeriodId(kind, id);
  const prevSeal = store.periods.find((p) => p.kind === kind && p.id === prevId) ?? null;
  // An older seal of this kind existing while the adjacent one is missing is a
  // hole in the chain — flagged (assertion 7), not fatal.
  const prevSealExpected = !prevSeal && store.periods.some((p) => p.kind === kind && Date.parse(p.to) <= from);

  const record = computePeriodRecord({
    kind,
    id,
    snapshots,
    prevSeal,
    prevSealExpected,
    // assertion 10: the year seal verifies itself against the 12 monthly
    // seals — the reason the 1 Jan cron order (00:30 month → 00:35 year) and
    // the watchdog's month-before-year sealing exist.
    monthlySeals: kind === "year" ? store.periods : null,
    driftToleranceSol: Number(config.report.driftToleranceSol ?? 0.001),
    sealedAtIso: new Date(now).toISOString(),
  });

  if (existing) store.periods = store.periods.filter((p) => !(p.kind === kind && p.id === id));
  store.periods.push(record);
  savePeriods(wallet, store);
  log(
    "ledger",
    `Seal ${kind} ${id}${reseal && existing ? " (RESEAL)" : ""}: net_rill ${record.pnl.net_rill_sol} SOL, ` +
    `integrity_ok=${record.integrity.integrity_ok}${record.integrity.assertions_failed.length ? ` [${record.integrity.assertions_failed.join("; ")}]` : ""}`,
  );
  return record;
}
