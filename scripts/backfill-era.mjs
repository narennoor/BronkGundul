// Reconstruct the closed-position bookkeeping of a WIPED era and store it in
// lessons.json under `performance_archive`.
//
//   node scripts/backfill-era.mjs --before 2026-08-06T00:00:00Z [--dry-run]
//
// Why this exists
// ---------------
// `lessons.json → performance` holds the LIVE era only; changing eras wipes it.
// A wallet outlives its eras, so /pnl ends up comparing chain history that
// starts on day 1 against books that start at the current era — and the whole
// difference lands on the execution-cost row as phantom cost. On 26 Aug 2026
// that hid 16 days (21 Jul – 5 Aug, 487 closes, -1.33 SOL) and made a -1.3 SOL
// wallet look like +85 SOL of execution profit.
//
// Only pnl-report.js reads `performance_archive`. It is deliberately NOT part
// of `performance`: evolveThresholds / recalculateWeights / the prompt summary
// would then tune the live agent on a market regime that no longer exists.
//
// Method (each step validated against era-2 ground truth before use)
// ------------------------------------------------------------------
// 1. Walk the wallet's Helius history back past `--before`.
// 2. Position accounts = accounts whose FIRST chronological credit is
//    rent-sized (0.04-0.2 SOL) and whose running balance never exceeds
//    0.16 SOL. The balance ceiling is load-bearing: without it a pool's wSOL
//    vault matches the credit test and poisons every total.
// 3. Pool = the account immediately AFTER the position account in the DLMM
//    instruction that created it (verified 8/8 against state.json).
// 4. Meteora datapi per pool → closed positions with pnlSol, fees, timestamps.
//    There is no wallet-wide closed endpoint; it must be queried per pool.
// 5. Cross-check: the sum of reconstructed pnl_sol must land within
//    (gas + a plausible execution cost) of the era's on-chain wallet delta.
import { loadEnv } from "../envcrypt.js";
import fs from "fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { repoPath } from "../repo-root.js";

loadEnv();

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const dryRun = argv.includes("--dry-run");
const beforeIso = flag("--before");
if (!beforeIso || !Number.isFinite(Date.parse(beforeIso))) {
  console.error("usage: node scripts/backfill-era.mjs --before <ISO> [--dry-run]");
  process.exit(1);
}
const BEFORE = Date.parse(beforeIso) / 1000;
const LBUZ = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

async function getJson(url, { retries = 5 } = {}) {
  let wait = 1000;
  for (let i = 0; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
    if (i >= retries) throw new Error(`HTTP ${res.status} after ${retries} retries`);
    const ra = Number(res.headers.get("retry-after"));
    await sleep(ra > 0 ? ra * 1000 : wait);
    wait = Math.min(wait * 2, 15000);
  }
}

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
if (!process.env.HELIUS_API_KEY) { console.error("HELIUS_API_KEY not set"); process.exit(1); }

// ── 1. walk ────────────────────────────────────────────────────────
const deltas = [], ixLists = [];
let before, kept = 0, gas = 0, walletDelta = 0;
for (let page = 0; page < 200; page++) {
  const u = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
  u.searchParams.set("api-key", process.env.HELIUS_API_KEY);
  u.searchParams.set("limit", "100");
  if (before) u.searchParams.set("before", before);
  const batch = await getJson(u);
  if (!batch.length) break;
  for (const t of batch) {
    if (t.timestamp >= BEFORE) continue;
    kept++;
    if (t.feePayer === wallet) gas += t.fee / 1e9;
    for (const a of t.accountData || []) {
      if (!a.nativeBalanceChange) continue;
      if (a.account === wallet) walletDelta += a.nativeBalanceChange / 1e9;
      deltas.push({ a: a.account, ts: t.timestamp, d: a.nativeBalanceChange / 1e9 });
    }
    for (const i of t.instructions || []) {
      if (i.programId === LBUZ && (i.accounts || []).length) ixLists.push(i.accounts);
    }
  }
  before = batch[batch.length - 1].signature;
  process.stderr.write(`\rpage ${page + 1} — ${kept} tx before cutoff`);
  await sleep(300);
}
process.stderr.write("\n");
if (!kept) { console.log("No transactions before the cutoff — nothing to backfill."); process.exit(0); }

// ── 2. position accounts (CHRONOLOGICAL — a reverse walk inverts the test) ──
deltas.sort((a, b) => a.ts - b.ts);
const acc = new Map();
for (const { a, d } of deltas) {
  const e = acc.get(a) || { first: null, cum: 0, max: 0 };
  if (e.first === null) e.first = d;
  e.cum += d; if (e.cum > e.max) e.max = e.cum;
  acc.set(a, e);
}
const candidates = new Set(
  [...acc.entries()]
    .filter(([a, e]) => a !== wallet && e.first >= 0.04 && e.first <= 0.2 && e.max <= 0.16)
    .map(([a]) => a),
);

// ── 3. pool = next account after the position in its DLMM instruction ──
const posToPool = new Map();
for (const accounts of ixLists) {
  for (let i = 0; i < accounts.length - 1; i++) {
    if (candidates.has(accounts[i]) && !posToPool.has(accounts[i])) posToPool.set(accounts[i], accounts[i + 1]);
  }
}
const pools = [...new Set(posToPool.values())];
console.log(`position accounts: ${candidates.size} | mapped to pools: ${posToPool.size} | unique pools: ${pools.length}`);

// ── 4. Meteora datapi, per pool ────────────────────────────────────
const rows = [];
let poolFail = 0;
for (let i = 0; i < pools.length; i++) {
  try {
    const j = await getJson(`https://dlmm.datapi.meteora.ag/positions/${pools[i]}/pnl?user=${wallet}&status=closed&pageSize=100&page=1`);
    for (const r of j?.data ?? j?.positions ?? (Array.isArray(j) ? j : [])) rows.push({ ...r, pool: pools[i] });
  } catch { poolFail++; }
  process.stderr.write(`\rpool ${i + 1}/${pools.length} — ${rows.length} closed rows`);
  await sleep(150);
}
process.stderr.write("\n");

const entries = rows
  .filter((r) => r.isClosed && r.closedAt < BEFORE)
  .sort((a, b) => a.closedAt - b.closedAt)
  .map((r) => ({
    position: r.positionAddress,
    pool: r.pool,
    pool_name: `${r.pool.slice(0, 8)}…`,
    amount_sol: Math.round(num(r.allTimeDeposits?.total?.sol) * 1e6) / 1e6,
    deposits_sol: num(r.allTimeDeposits?.total?.sol),
    withdrawals_sol: num(r.allTimeWithdrawals?.total?.sol),
    pnl_sol: num(r.pnlSol),
    pnl_usd: num(r.pnlUsd),
    pnl_pct: num(r.pnlSolPctChange),
    fees_earned_sol: num(r.allTimeFees?.total?.sol),
    fees_earned_usd: num(r.allTimeFees?.total?.usd),
    minutes_held: Math.max(0, Math.round((r.closedAt - r.createdAt) / 60)),
    close_reason: "era backfill (close reason not recorded)",
    recorded_at: new Date(r.closedAt * 1000).toISOString(),
    backfilled: true,
    source: "meteora-datapi",
  }));

// ── 5. cross-check against the chain ───────────────────────────────
const bookSol = entries.reduce((s, e) => s + e.pnl_sol, 0);
const feeSol = entries.reduce((s, e) => s + e.fees_earned_sol, 0);
console.log(`\nreconstructed: ${entries.length} closes  Σ pnl_sol ${bookSol.toFixed(4)} SOL  Σ fees ${feeSol.toFixed(4)} SOL`);
console.log(`chain wallet delta over the era: ${walletDelta.toFixed(4)} SOL (gas ${gas.toFixed(4)})`);
console.log(`unexplained (= execution cost): ${(bookSol - walletDelta - gas).toFixed(4)} SOL` +
  (entries.length ? ` = ${((bookSol - walletDelta - gas) / entries.length).toFixed(5)} SOL/close` : ""));
console.log("  NOTE: the wallet delta also carries deposits/withdrawals made during the era —");
console.log("  subtract those by hand before reading the residual as pure execution cost.");
if (poolFail) console.log(`WARNING: ${poolFail} pool(s) failed to fetch — their closes are missing.`);
const unmapped = candidates.size - posToPool.size;
if (unmapped > 0) console.log(`WARNING: ${unmapped} position account(s) never appeared in a DLMM instruction — not reconstructed.`);

if (dryRun) { console.log("\n[DRY RUN — lessons.json untouched]"); process.exit(0); }

// ── write: merge by position, never touch `performance` ────────────
const path = repoPath("lessons.json");
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const live = new Set((data.performance || []).map((p) => p.position));
const archive = data.performance_archive || [];
const have = new Set(archive.map((p) => p.position));
let added = 0, skippedLive = 0;
for (const e of entries) {
  if (live.has(e.position)) { skippedLive++; continue; }   // already booked for real
  if (have.has(e.position)) continue;
  archive.push(e); have.add(e.position); added++;
}
archive.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
data.performance_archive = archive;
fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log(`\nperformance_archive: +${added} (total ${archive.length})${skippedLive ? `, ${skippedLive} skipped — already in live performance` : ""}`);
