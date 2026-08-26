// pnl-report.js — comprehensive PnL report: app bookkeeping (fee LP + IL from
// lessons.json) reconciled against real on-chain SOL flows (Helius), plus gas
// and LLM cost. The gap between bookkeeping and on-chain cash is reported as
// execution cost (swap slippage, referral, quote-vs-execution drift).
//
// Used by scripts/pnl-report.mjs (CLI) and the Telegram /pnl command.

import fs from "fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const OUTFLOW_TX_TYPES = new Set([
  "INITIALIZE_POSITION",
  "INITIALIZE_BIN_ARRAY",
  "ADD_LIQUIDITY",
  "UNKNOWN",
]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(repoPath(file), "utf8"));
  } catch {
    return fallback;
  }
}

function walletChange(tx, wallet) {
  const entry = (tx.accountData || []).find((a) => a.account === wallet);
  return entry ? entry.nativeBalanceChange / 1e9 : 0;
}

/**
 * Reporting cutoff (`pnlReportSinceIso`). The wallet usually predates the agent:
 * manual swaps, test transfers and unrelated deposits sit in the same Helius
 * history and drag gas, deposits and equity into a report that claims to
 * describe the agent. With a cutoff set, everything before it collapses into a
 * single opening-balance number and the report measures the agent only.
 * null = whole history (previous behavior).
 */
export function resolveReportCutoff(iso = config.pnl?.reportSinceIso) {
  if (!iso) return null;
  // The shape check is NOT redundant with Date.parse: V8's fallback parser
  // accepts almost anything and silently invents a date — `Date.parse("21 juli")`
  // returns 2001-07-21, which would quietly cut off nothing at all. Demand a
  // leading YYYY-MM-DD so a typo fails loudly instead.
  const ms = /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(String(iso).trim()) ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`pnlReportSinceIso tidak valid: "${iso}" — pakai ISO, mis. 2026-07-21T00:00:00Z`);
  }
  return { since: new Date(ms).toISOString(), ms, sec: Math.floor(ms / 1000) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_DELAY_MS = 250;
const MAX_PAGE_DELAY_MS = 2000;

/**
 * One Helius page, with backoff. A bare 429 used to abort the whole report —
 * the wallet is thousands of txs deep, so a single walk is 60+ requests and the
 * consistency loop could triple that. Rate limits are expected here, not
 * exceptional; honor Retry-After when the server sends one.
 */
async function fetchTxPage(url, { retries = 5 } = {}) {
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return { batch: await res.json(), throttled: attempt > 0 };
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Helius ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
    if (attempt >= retries) {
      throw new Error(
        `Helius ${res.status} setelah ${retries} percobaan — rate limit belum reda, coba lagi beberapa menit lagi`,
      );
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait);
    wait = Math.min(wait * 2, 15000);
  }
}

/**
 * Walk the wallet history newest-first.
 *
 * `stopBeforeSec` (the cutoff) ends the walk as soon as a page reaches past it:
 * pre-cutoff txs contribute nothing but an opening balance, and that is derived
 * from the current balance instead. Without it, every /pnl re-walked the entire
 * chain history — unbounded in both Helius credits and wall clock.
 *
 * `known` short-circuits the consistency loop's later attempts: when the walk
 * reaches a signature already held, the rest of the previous walk is still
 * valid, so only the newly-landed txs are refetched.
 *
 * Returns `complete` (the walk ran off the end of history — the strong
 * flowSum === balance check is available) and `reachedCutoff` (we paged back
 * past the cutoff — the in-scope window is whole).
 */
async function fetchAllTxs(wallet, heliusKey, { stopBeforeSec = null, known = null } = {}) {
  const txs = [];
  let before;
  let pageDelay = PAGE_DELAY_MS;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
    url.searchParams.set("api-key", heliusKey);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);
    const { batch, throttled } = await fetchTxPage(url);
    // A throttled page means we are pushing too hard; stay slower for the rest
    // of the walk rather than earning another 429 on the very next request.
    if (throttled) pageDelay = Math.min(pageDelay * 2, MAX_PAGE_DELAY_MS);
    if (!batch.length) return { txs, complete: true, reachedCutoff: true, resumed: false };
    if (known?.size) {
      const hit = batch.findIndex((t) => known.has(t.signature));
      if (hit >= 0) {
        txs.push(...batch.slice(0, hit));
        return { txs, complete: false, reachedCutoff: true, resumed: true };
      }
    }
    txs.push(...batch);
    if (stopBeforeSec != null && batch.some((t) => t.timestamp < stopBeforeSec)) {
      return { txs, complete: false, reachedCutoff: true, resumed: false };
    }
    before = batch[batch.length - 1].signature;
    await sleep(pageDelay);
  }
  return { txs, complete: false, reachedCutoff: false, resumed: false };
}

async function fetchBalance(wallet) {
  const res = await fetch(process.env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC getBalance: ${json.error.message}`);
  return json.result.value / 1e9;
}

async function fetchSolPrice() {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const price = (await res.json())?.[SOL_MINT]?.usdPrice;
  if (!price) throw new Error("Gagal ambil harga SOL dari Jupiter Price API");
  return price;
}

async function fetchLlmUsage() {
  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    return (await res.json())?.data?.usage ?? null;
  } catch {
    return null;
  }
}

/**
 * Split the raw history at the cutoff. Everything before it collapses into ONE
 * number — the wallet balance at that instant, derived from the pre-cutoff
 * flows — and is otherwise invisible: its gas, deposits and withdrawals never
 * enter the report.
 *
 * Closed cycles are dated by `recorded_at`. An entry without one cannot be
 * placed on either side of the cutoff, so it is dropped and counted; keeping it
 * would re-introduce exactly the pre-agent noise the cutoff exists to remove.
 *
 * `cutoff: null` is the identity transform (whole history, original behavior).
 */
export function applyCutoff({ txs, perf, wallet, cutoff, balance = 0 }) {
  if (!cutoff) {
    return { inScopeTxs: txs, preCutoffTxs: [], openingBalance: 0, perf, perfUndated: 0 };
  }
  const inScopeTxs = txs.filter((t) => t.timestamp >= cutoff.sec);
  const preCutoffTxs = txs.filter((t) => t.timestamp < cutoff.sec);
  const dated = (p) => Date.parse(p?.recorded_at);
  return {
    inScopeTxs,
    preCutoffTxs,
    // Derived from the CURRENT balance, not from summing pre-cutoff flows: the
    // walk stops at the cutoff, so those flows are only partially fetched. When
    // the whole history happens to be walked the two agree by construction —
    // that agreement is the flowSum === balance check.
    openingBalance: balance - inScopeTxs.reduce((s, t) => s + walletChange(t, wallet), 0),
    perf: perf.filter((p) => Number.isFinite(dated(p)) && dated(p) >= cutoff.ms),
    perfUndated: perf.filter((p) => !Number.isFinite(dated(p))).length,
  };
}

/**
 * Compute the full report. Throws on missing env (HELIUS_API_KEY, RPC_URL,
 * WALLET_PRIVATE_KEY) or unreachable price API; LLM usage failure is non-fatal.
 */
export async function computePnlReport() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not set");
  if (!process.env.RPC_URL) throw new Error("RPC_URL not set");

  const cutoff = resolveReportCutoff();
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();

  // ── on-chain flows + local state, sampled as one atomic pass ──
  // `balance`, `state.json` and `lessons.json` MUST describe the same instant.
  // The report runs for 60-90s (Helius paging), and a close landing inside
  // that span used to be counted twice — once as locked capital from the
  // stale state read, once as SOL already back in the freshly-read balance.
  // On 3 Aug 2026 that inflated equity by 3.71 SOL and ROI by 15pp, with no
  // warning shown. Guard: read the JSON files right next to the balance, then
  // re-read the balance; if anything moved, redo the pass.
  //
  // With a cutoff set the walk STOPS there. The wallet is thousands of txs deep
  // and this ran on every /pnl, which is what earned the Helius 429 (and burned
  // credits the rest of the agent needs). Pre-cutoff txs contribute nothing but
  // an opening balance, and that is derived from the current balance instead:
  //   opening = balance − (flows since the cutoff)
  // exact as long as the in-scope window is whole, which `reachedCutoff` proves.
  // Walking the WHOLE history (no cutoff) still gets the stronger check —
  // flowSum === balance, which catches a tx dropped anywhere.
  let txs = [], balance, flowSum, perfAll, statePositions, walk;
  let consistent = false, walkTrusted = false, snapshotStable = false;
  for (let attempt = 0; attempt < 3 && !consistent; attempt++) {
    // Later attempts only refetch what landed since the last walk — re-walking
    // the full history is what turned a busy wallet into a rate-limit spiral.
    const known = attempt > 0 ? new Set(txs.map((t) => t.signature)) : null;
    const fresh = await fetchAllTxs(wallet, process.env.HELIUS_API_KEY, {
      stopBeforeSec: cutoff?.sec ?? null,
      known,
    });
    txs = fresh.resumed
      ? [...fresh.txs, ...txs]
      : fresh.txs;
    walk = fresh.resumed ? { ...fresh, complete: walk.complete, reachedCutoff: walk.reachedCutoff } : fresh;
    balance = await fetchBalance(wallet);
    perfAll = readJson("lessons.json", {}).performance || [];
    statePositions = Object.values(readJson("state.json", {}).positions || {});
    const balanceAfterReads = await fetchBalance(wallet);
    flowSum = txs.reduce((s, t) => s + walletChange(t, wallet), 0);
    walkTrusted = walk.complete
      ? Math.abs(flowSum - balance) < 1e-6   // whole history: the strong check
      : walk.reachedCutoff;                  // partial walk: in-scope window is whole
    snapshotStable = balance === balanceAfterReads;
    consistent = walkTrusted && snapshotStable;
  }
  const openPositions = statePositions.filter((p) => !p.closed);

  const { inScopeTxs, preCutoffTxs, openingBalance, perf, perfUndated } =
    applyCutoff({ txs, perf: perfAll, wallet, cutoff, balance });

  // ── app bookkeeping ────────────────────────────────────────────
  // Two numeraires, both real and NOT interchangeable:
  //   pnl_usd  = (withdrawals + fees − deposits) priced in USD by Meteora
  //   pnl_sol  = the same cycle measured in SOL (Meteora's pnlSol)
  // A position that is flat in SOL still shows a USD profit when SOL rises
  // during the hold. The wallet is SOL-denominated, so the SOL column must
  // come from pnl_sol — converting the USD sum at ONE current price smears
  // a month of SOL price moves into the execution-cost residual (it hid
  // ~1.10 SOL as of 3 Aug 2026).
  let pnlUsd = 0, pnlSol = 0, feesUsd = 0, wins = 0, losses = 0, heldMin = 0;
  let missingPnlSol = 0, missingPnlUsd = 0;
  let feesSolNative = 0, feesUsdNoSol = 0, feesSolExact = 0;
  for (const p of perf) {
    pnlUsd += p.pnl_usd || 0;
    // Pre-dual-field entries (none as of 3 Aug 2026) fall back to the old
    // current-price conversion so the total stays complete, and get counted
    // so the report can warn that the SOL column is partly approximate.
    if (Number.isFinite(p.pnl_sol)) pnlSol += p.pnl_sol;
    else { missingPnlSol++; missingPnlUsd += p.pnl_usd || 0; }
    feesUsd += p.fees_earned_usd || 0;
    // `fees_earned_sol` only exists from 3 Aug 2026 on, so the SOL fee total is
    // exact for those closes and current-price-approximated for the rest. The
    // mix converges to fully exact on its own; coverage is reported so nobody
    // has to guess how approximate the row currently is.
    if (Number.isFinite(p.fees_earned_sol)) { feesSolNative += p.fees_earned_sol; feesSolExact++; }
    else feesUsdNoSol += p.fees_earned_usd || 0;
    (p.pnl_usd || 0) >= 0 ? wins++ : losses++;
    heldMin += p.minutes_held || 0;
  }
  const ilUsd = pnlUsd - feesUsd;

  let gasSol = 0, gasTxn = 0, depositIn = 0, withdrawOut = 0;
  for (const t of inScopeTxs) {
    if (t.feePayer === wallet) { gasSol += t.fee / 1e9; gasTxn++; }
    // SOL arriving while the wallet sends tokens in the same tx is a swap fill
    // (Jupiter RFQ: the market maker is feePayer and pays out via system
    // transfer), not a deposit.
    const isSwapFill = (t.tokenTransfers || []).some((tt) => tt.fromUserAccount === wallet);
    for (const nt of t.nativeTransfers || []) {
      if (nt.amount <= 5e6) continue;
      if (nt.toUserAccount === wallet && t.feePayer !== wallet && !isSwapFill) depositIn += nt.amount / 1e9;
      if (nt.fromUserAccount === wallet && t.feePayer === wallet && t.type === "TRANSFER") withdrawOut += nt.amount / 1e9;
    }
  }
  const depositNet = depositIn - withdrawOut;
  // Capital the agent started from = wallet balance at the cutoff + net deposits
  // since. Without a cutoff the opening balance is 0 and this is the old
  // `depositNet`, unchanged.
  const baseCapital = openingBalance + depositNet;

  // SOL locked in open positions = their deploy txs (principal + rent + gas).
  // Matched by the signatures recorded at deploy time. The old ±150s timestamp
  // window assumed deploys are always minutes apart; that broke on 2 of 54
  // closes in the 3 Aug 2026 reconciliation once deploys landed close together,
  // and a mismatch here silently mis-states equity. Positions deployed before
  // `deploy_txs` existed still use the window, and say so.
  //
  // Matched against the FULL tx list, not the in-scope slice: locked capital is
  // locked whenever it was deployed. A position deployed BEFORE the cutoff is
  // already accounted for inside `openingBalance` (its outflow reduced that
  // balance), so counting it again here would double it — flagged and warned
  // rather than silently absorbed.
  const openDetail = openPositions.map((p) => {
    const sigs = Array.isArray(p.deploy_txs) ? p.deploy_txs.filter(Boolean) : [];
    let mine = sigs.length ? txs.filter((t) => sigs.includes(t.signature)) : [];
    // A recorded signature that is not in the fetched history (paging limit,
    // or an RPC that dropped it) would silently under-count the outflow.
    const matchedBy = sigs.length && mine.length === sigs.length ? "signature" : "timestamp";
    if (matchedBy === "timestamp") {
      const t0 = Date.parse(p.deployed_at) / 1000;
      mine = txs.filter(
        (t) => t.timestamp >= t0 - 20 && t.timestamp <= t0 + 150 &&
          OUTFLOW_TX_TYPES.has(t.type) && walletChange(t, wallet) < 0,
      );
    }
    const outflow = -mine.reduce((s, t) => s + walletChange(t, wallet), 0);
    const gasIn = mine.reduce((s, t) => s + (t.feePayer === wallet ? t.fee / 1e9 : 0), 0);
    return {
      pool: p.pool_name, principal: p.amount_sol || 0, outflow, gasIn,
      deployed_at: p.deployed_at, matched_by: matchedBy,
      pre_cutoff: Boolean(cutoff && Date.parse(p.deployed_at) < cutoff.ms),
    };
  });
  const lockedOut = openDetail.reduce((s, o) => s + o.outflow, 0);
  const lockedGas = openDetail.reduce((s, o) => s + o.gasIn, 0);
  const lockedPrincipal = openDetail.reduce((s, o) => s + o.principal, 0);
  const lockedRent = lockedOut - lockedPrincipal - lockedGas;

  const solPrice = await fetchSolPrice();
  // OpenRouter reports usage for the LIFETIME of the key, which has no cutoff of
  // its own. `pnlReportLlmUsdBaseline` is the reading taken at the cutoff; set it
  // and the report charges only what the agent spent since.
  const llmUsdLifetime = await fetchLlmUsage();
  const llmBaseline = Number.isFinite(config.pnl?.reportLlmUsdBaseline)
    ? config.pnl.reportLlmUsdBaseline
    : null;
  const llmUsd = llmUsdLifetime == null ? null : Math.max(0, llmUsdLifetime - (llmBaseline ?? 0));

  // ── the bridge: bookkeeping → real cash ────────────────────────
  // SOL side is native (pnl_sol); USD side stays USD-native. The two do NOT
  // convert into each other — that is the point, see the note above.
  const netRevBookUsd = pnlUsd;
  const netRevBookSol = pnlSol + missingPnlUsd / solPrice;
  // Fee LP: native SOL where recorded, current-price fallback for the rest.
  // IL stays derived (net − fees) so the column adds up and whatever
  // approximation remains lands on the IL row, never on the bottom line.
  const feesSol = feesSolNative + feesUsdNoSol / solPrice;
  const ilSol = netRevBookSol - feesSol;
  // realized cash of all CLOSED cycles = balance + locked − capital put in
  const grossRealSol = balance + lockedOut - baseCapital;        // after gas
  const netRevRealSol = grossRealSol + gasSol - lockedGas;        // before gas
  const execCostSol = netRevBookSol - netRevRealSol;
  const llmSol = llmUsd != null ? llmUsd / solPrice : 0;
  const netRealSol = grossRealSol - llmSol;

  return {
    generated_at: new Date().toISOString(),
    wallet,
    sol_price: solPrice,
    consistent,
    walk: {
      trusted: walkTrusted,
      snapshot_stable: snapshotStable,
      complete: walk.complete,
      reached_cutoff: walk.reachedCutoff,
      txs_walked: txs.length,
    },
    cutoff: cutoff
      ? {
          since: cutoff.since,
          opening_balance_sol: openingBalance,
          pre_cutoff_txs: preCutoffTxs.length,
          perf_undated_dropped: perfUndated,
          perf_before_cutoff: perfAll.length - perf.length - perfUndated,
        }
      : null,
    perf: {
      closed: perf.length, wins, losses,
      win_rate_pct: perf.length ? Math.round((wins / perf.length) * 100) : 0,
      avg_held_min: perf.length ? Math.round(heldMin / perf.length) : 0,
      fees_usd: feesUsd, il_usd: ilUsd, net_rev_usd: netRevBookUsd,
      fees_sol: feesSol, il_sol: ilSol, net_rev_sol: netRevBookSol,
      missing_pnl_sol: missingPnlSol,
      fees_sol_exact: feesSolExact,
    },
    bridge: {
      net_rev_book_sol: netRevBookSol,
      exec_cost_sol: execCostSol,
      net_rev_real_sol: netRevRealSol,
      gas_sol: gasSol, gas_txn: gasTxn,
      gross_real_sol: grossRealSol,
      llm_usd: llmUsd, llm_sol: llmSol,
      llm_usd_lifetime: llmUsdLifetime, llm_usd_baseline: llmBaseline,
      net_real_sol: netRealSol,
      net_book_usd: netRevBookUsd - gasSol * solPrice - (llmUsd || 0),
    },
    equity: {
      opening_balance: openingBalance,
      deposit_in: depositIn, withdraw_out: withdrawOut, deposit_net: depositNet,
      base_capital: baseCapital,
      balance, locked_principal: lockedPrincipal, locked_rent: lockedRent,
      total: balance + lockedOut,
      drift_sol: balance + lockedOut - baseCapital,
    },
    open: openDetail,
    tx_count: inScopeTxs.length,
    tx_count_total: txs.length,
  };
}

const fmtUsd = (v, sign = true) => `${v < 0 ? "-" : sign ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtSol = (v, sign = true) => `${v < 0 ? "-" : sign ? "+" : ""}${Math.abs(v).toFixed(4)}`;
const stampOf = (iso) => iso.slice(0, 16).replace("T", " ");

/**
 * Render the report as aligned plain text (CLI) or Telegram HTML (<pre> block).
 */
export function formatPnlReport(r, { html = false } = {}) {
  const sp = r.sol_price;
  const row = (label, usd, sol) =>
    `${label.padEnd(18)}${fmtUsd(usd).padStart(9)}${fmtSol(sol).padStart(10)}`;
  const eqRow = (label, sol, note) =>
    `${label.padEnd(18)}${fmtSol(sol, false).padStart(10)}${note ? `  ${note}` : ""}`;
  const b = r.bridge;
  const e = r.equity;

  const lines = [
    r.cutoff ? `Periode: sejak ${stampOf(r.cutoff.since)} UTC (transaksi sebelumnya dikecualikan)` : null,
    `${r.perf.closed} closed | ${r.perf.wins}W/${r.perf.losses}L (${r.perf.win_rate_pct}%) | avg hold ${r.perf.avg_held_min}m | ${r.open.length} open`,
    "",
    "PEMBUKUAN (posisi closed)         USD       SOL",
    row("Fee LP", r.perf.fees_usd, r.perf.fees_sol),
    row("Impermanent loss", r.perf.il_usd, r.perf.il_sol),
    row("Net Revenue", r.perf.net_rev_usd, r.perf.net_rev_sol),
    "  USD & SOL diukur terpisah (bukan konversi) — selisihnya = gerak",
    "  harga SOL selama posisi dipegang. Kolom SOL yang dipakai di bawah.",
    r.perf.fees_sol_exact < r.perf.closed
      ? `  Fee LP kolom SOL: ${r.perf.fees_sol_exact}/${r.perf.closed} eksak, sisanya perkiraan harga kini (IL menyerap selisihnya).`
      : null,
    "",
    "KAS RIIL ON-CHAIN",
    row("Biaya eksekusi", -b.exec_cost_sol * sp, -b.exec_cost_sol),
    row("Net Revenue riil", b.net_rev_real_sol * sp, b.net_rev_real_sol),
    row(`Gas (${b.gas_txn} tx)`, -b.gas_sol * sp, -b.gas_sol),
    row("Gross riil", b.gross_real_sol * sp, b.gross_real_sol),
    b.llm_usd != null
      ? row("LLM (OpenRouter)", -b.llm_usd, -b.llm_sol)
      : "LLM (OpenRouter)      n/a",
    b.llm_usd != null && b.llm_usd_baseline
      ? `  LLM = ${fmtUsd(b.llm_usd_lifetime, false)} seumur key - baseline ${fmtUsd(b.llm_usd_baseline, false)} di cutoff.`
      : null,
    b.llm_usd != null && r.cutoff && b.llm_usd_baseline == null
      ? "  ⚠️ LLM masih total seumur key (belum di-cutoff) — set pnlReportLlmUsdBaseline (0 kalau key-nya dibuat setelah cutoff)."
      : null,
    row("NET RIIL", b.net_real_sol * sp, b.net_real_sol),
    "",
    `Memo NET versi pembukuan: ${fmtUsd(b.net_book_usd)}`,
    "",
    "EKUITAS (SOL)",
    r.cutoff ? eqRow("Saldo awal", e.opening_balance, `(${stampOf(r.cutoff.since)} UTC)`) : null,
    eqRow("Deposit netto", e.deposit_net, r.cutoff ? "(sejak cutoff)" : ""),
    r.cutoff ? eqRow("Modal dasar", e.base_capital, "(= saldo awal + deposit)") : null,
    eqRow("Saldo bebas", e.balance),
    eqRow(`Modal ${String(r.open.length).padStart(2)} posisi`, e.locked_principal, `(+rent ${e.locked_rent.toFixed(4)})`),
    eqRow("Ekuitas", e.total, `(${fmtUsd(e.total * sp, false)})`),
    `${"Untung/rugi".padEnd(18)}${fmtSol(b.net_real_sol).padStart(10)}  (${fmtUsd(b.net_real_sol * sp)})`,
    `  = ekuitas - ${r.cutoff ? "modal dasar" : "deposit"} - biaya LLM`,
    `${"ROI".padEnd(18)}${(e.base_capital > 0
      ? `${b.net_real_sol >= 0 ? "+" : ""}${((b.net_real_sol / e.base_capital) * 100).toFixed(2)}%`
      : "n/a").padStart(10)}`,
  ];
  if (r.open.length) {
    // "~" marks a position whose deploy txs were matched by timestamp window
    // instead of recorded signatures — its locked-SOL figure can be off.
    lines.push("", `Open: ${r.open.map((o) => `${o.pool} ${o.principal}${o.matched_by === "timestamp" ? "~" : ""}`).join(" | ")}`);
    const fuzzy = r.open.filter((o) => o.matched_by === "timestamp").length;
    if (fuzzy) {
      lines.push(`  ~ ${fuzzy} posisi dicocokkan lewat jendela waktu (deploy_txs belum terekam) — modal terkuncinya bisa meleset.`);
    }
  }
  if (b.exec_cost_sol < -0.005) {
    lines.push("", "⚠️ Kas riil LEBIH BAIK dari pembukuan — biasanya ada entri close dengan quote pool yang salah (mis. flash-dump saat close). On-chain yang benar; cek entri performance terakhir.");
  }
  if (r.perf.missing_pnl_sol) {
    lines.push("", `⚠️ ${r.perf.missing_pnl_sol} entri tanpa pnl_sol — bagian itu masih dikonversi pakai harga SOL saat ini, jadi kolom SOL sedikit perkiraan.`);
  }
  if (r.cutoff) {
    const preCutoffOpen = r.open.filter((o) => o.pre_cutoff).length;
    if (preCutoffOpen) {
      lines.push("", `⚠️ ${preCutoffOpen} posisi terbuka di-deploy SEBELUM cutoff — modalnya sudah ikut di saldo awal, jadi terhitung dua kali. Tutup posisi itu atau geser cutoff ke sebelum deploy-nya.`);
    }
    if (r.cutoff.perf_undated_dropped) {
      lines.push("", `⚠️ ${r.cutoff.perf_undated_dropped} entri performance tanpa recorded_at dibuang (tak bisa ditempatkan pada cutoff) — selisihnya jatuh ke baris biaya eksekusi.`);
    }
  }
  // The two ways the snapshot can be untrustworthy are different problems with
  // different fixes; one message for both used to send you looking in the wrong place.
  if (r.walk && !r.walk.trusted) {
    lines.push("", r.walk.reached_cutoff
      ? "⚠️ Riwayat Helius tidak menutup seluruh saldo wallet — ada tx yang hilang di tengah. Angka kasnya bisa meleset."
      : "⚠️ Penelusuran riwayat berhenti sebelum mencapai cutoff (batas 100 halaman) — saldo awal tidak bisa dihitung. Majukan pnlReportSinceIso ke era yang lebih baru.");
  }
  if (r.walk && !r.walk.snapshot_stable) {
    lines.push("", "⚠️ Saldo berubah saat laporan dihitung setelah 3 percobaan — ada tx/close yang mendarat di sela. Posisi yang tutup di situ bisa terhitung DUA KALI (modal terkunci + saldo). Jangan dipakai; ulangi saat agen sedang tenang.");
  } else if (!r.consistent && !r.walk) {
    lines.push("", "⚠️ Snapshot tidak sinkron setelah 3 percobaan — jangan dipakai; ulangi saat agen sedang tenang.");
  }

  const title = `📒 PnL Meridian — ${stampOf(r.generated_at)} UTC | SOL $${sp.toFixed(2)}`;
  // Conditional rows are emitted as null; drop them so they don't become blanks.
  const body = lines.filter((l) => l != null).join("\n");
  if (html) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<b>${esc(title)}</b>\n<pre>${esc(body)}</pre>`;
  }
  return `${title}\n${body}`;
}
