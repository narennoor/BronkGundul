// /pnl reporting cutoff (`pnlReportSinceIso`).
//
// The wallet predates the agent: funding transfers, manual swaps and test txs
// sat in the same Helius history, so gas, "deposit netto" and ROI all described
// the wallet rather than the agent. The cutoff folds everything before a chosen
// instant into a single opening balance and drops it from every other total.
//
// Pure-function tests — no network, no wallet. _setup.mjs isolates state into a
// temp MERIDIAN_STATE_DIR (config.js is imported transitively).

import "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { resolveReportCutoff, applyCutoff, formatPnlReport } = await import("../pnl-report.js");

const WALLET = "UNITTESTwa11et1111111111111111111111111111111";
const CUTOFF = resolveReportCutoff("2026-07-21T00:00:00Z");

// timestamp in seconds; nativeBalanceChange in lamports on the wallet's row
const tx = (iso, solChange, extra = {}) => ({
  signature: `sig-${iso}`,
  timestamp: Math.floor(Date.parse(iso) / 1000),
  feePayer: WALLET,
  fee: 5000,
  accountData: [{ account: WALLET, nativeBalanceChange: solChange * 1e9 }],
  ...extra,
});

test("resolveReportCutoff: null passes through, garbage throws", () => {
  assert.equal(resolveReportCutoff(null), null);
  assert.equal(resolveReportCutoff(""), null);
  assert.equal(resolveReportCutoff(undefined), null);
  // V8 would silently read these as 2001-07-21 / 2026-01-01 — a cutoff that
  // cuts off nothing. They must throw, not resolve.
  assert.throws(() => resolveReportCutoff("21 juli"), /pnlReportSinceIso tidak valid/);
  assert.throws(() => resolveReportCutoff("21/07/2026"), /pnlReportSinceIso tidak valid/);
  assert.throws(() => resolveReportCutoff("July 21 2026"), /pnlReportSinceIso tidak valid/);
  assert.throws(() => resolveReportCutoff("2026-13-45"), /pnlReportSinceIso tidak valid/);
  // plain dates and full ISO both work
  assert.equal(resolveReportCutoff("2026-07-21").since, "2026-07-21T00:00:00.000Z");
  assert.equal(CUTOFF.since, "2026-07-21T00:00:00.000Z");
  assert.equal(CUTOFF.sec, Date.parse("2026-07-21T00:00:00Z") / 1000);
});

test("pre-cutoff flows collapse into the opening balance and leave every other total", () => {
  const txs = [
    tx("2026-07-25T00:00:00Z", -0.5),   // agent deploy
    tx("2026-07-22T00:00:00Z", +2),     // agent-era top-up
    tx("2026-07-10T00:00:00Z", -1),     // pre-agent manual swap
    tx("2026-07-01T00:00:00Z", +9),     // pre-agent funding
  ];
  const r = applyCutoff({ txs, perf: [], wallet: WALLET, cutoff: CUTOFF });

  // 9 in, 1 out before 21 Jul → the wallet held 8 SOL when the agent took over
  assert.equal(r.openingBalance, 8);
  assert.equal(r.preCutoffTxs.length, 2);
  assert.deepEqual(r.inScopeTxs.map((t) => t.timestamp), [
    Math.floor(Date.parse("2026-07-25T00:00:00Z") / 1000),
    Math.floor(Date.parse("2026-07-22T00:00:00Z") / 1000),
  ]);
});

test("a tx exactly at the cutoff instant is IN scope", () => {
  const txs = [tx("2026-07-21T00:00:00Z", -0.3)];
  const r = applyCutoff({ txs, perf: [], wallet: WALLET, cutoff: CUTOFF });
  assert.equal(r.inScopeTxs.length, 1);
  assert.equal(r.openingBalance, 0);
});

test("closed cycles are filtered by recorded_at; undated ones are dropped AND counted", () => {
  const perf = [
    { recorded_at: "2026-07-19T12:00:00Z", pnl_sol: -5 },  // pre-agent
    { recorded_at: "2026-08-11T05:36:17.470Z", pnl_sol: 1 },
    { recorded_at: undefined, pnl_sol: 99 },
  ];
  const r = applyCutoff({ txs: [], perf, wallet: WALLET, cutoff: CUTOFF });
  assert.equal(r.perf.length, 1);
  assert.equal(r.perf[0].pnl_sol, 1);
  assert.equal(r.perfUndated, 1);
});

test("cutoff: null is the identity transform — pre-cutoff behavior is untouched", () => {
  const txs = [tx("2026-07-01T00:00:00Z", +9)];
  const perf = [{ recorded_at: undefined, pnl_sol: 3 }];
  const r = applyCutoff({ txs, perf, wallet: WALLET, cutoff: null });
  assert.equal(r.inScopeTxs, txs);
  assert.equal(r.perf, perf);
  assert.equal(r.openingBalance, 0);
  assert.equal(r.perfUndated, 0);
  assert.deepEqual(r.preCutoffTxs, []);
});

// ── report rendering ───────────────────────────────────────────────
function fakeReport(overrides = {}) {
  const base = {
    generated_at: "2026-08-26T16:00:00.000Z",
    wallet: WALLET,
    sol_price: 200,
    consistent: true,
    cutoff: {
      since: "2026-07-21T00:00:00.000Z",
      opening_balance_sol: 8,
      pre_cutoff_txs: 2,
      perf_undated_dropped: 0,
      perf_before_cutoff: 1,
    },
    perf: {
      closed: 10, wins: 6, losses: 4, win_rate_pct: 60, avg_held_min: 90,
      fees_usd: 100, il_usd: -40, net_rev_usd: 60,
      fees_sol: 0.5, il_sol: -0.2, net_rev_sol: 0.3,
      missing_pnl_sol: 0, fees_sol_exact: 10,
    },
    bridge: {
      net_rev_book_sol: 0.3, exec_cost_sol: 0.05, net_rev_real_sol: 0.25,
      gas_sol: 0.05, gas_txn: 40, gross_real_sol: 0.2,
      llm_usd: 4, llm_sol: 0.02, llm_usd_lifetime: 12, llm_usd_baseline: 8,
      net_real_sol: 0.18, net_book_usd: 40,
    },
    equity: {
      opening_balance: 8, deposit_in: 2, withdraw_out: 0, deposit_net: 2,
      base_capital: 10, balance: 9.68, locked_principal: 0.5, locked_rent: 0,
      total: 10.18, drift_sol: 0.18,
    },
    open: [],
    tx_count: 40,
    tx_count_total: 500,
  };
  return { ...base, ...overrides };
}

test("report states the period and shows opening balance + base capital", () => {
  const out = formatPnlReport(fakeReport());
  assert.match(out, /Periode: sejak 2026-07-21 00:00 UTC/);
  assert.match(out, /Saldo awal\s+8\.0000/);
  assert.match(out, /Modal dasar\s+10\.0000/);
  // ROI is measured against base capital (0.18/10), not the 2 SOL deposited since
  assert.match(out, /ROI\s+\+1\.80%/);
});

test("LLM row nets the baseline off the lifetime key usage", () => {
  const out = formatPnlReport(fakeReport());
  assert.match(out, /LLM = \$12\.00 seumur key - baseline \$8\.00 di cutoff/);
});

test("a cutoff with no LLM baseline says the LLM cost is still lifetime", () => {
  const r = fakeReport();
  r.bridge.llm_usd_baseline = 0;
  assert.match(formatPnlReport(r), /LLM masih total seumur key/);
});

test("an open position deployed before the cutoff is flagged as double-counted", () => {
  const r = fakeReport();
  r.open = [{ pool: "OLD-SOL", principal: 1, outflow: 1.1, gasIn: 0.001, deployed_at: "2026-07-01T00:00:00Z", matched_by: "signature", pre_cutoff: true }];
  assert.match(formatPnlReport(r), /di-deploy SEBELUM cutoff/);
});

test("no pre-cutoff tx in the history warns that the opening balance is assumed 0", () => {
  const r = fakeReport();
  r.cutoff.pre_cutoff_txs = 0;
  assert.match(formatPnlReport(r), /saldo awal dianggap 0/);
});

test("dropped undated performance entries are surfaced, not swallowed", () => {
  const r = fakeReport();
  r.cutoff.perf_undated_dropped = 3;
  assert.match(formatPnlReport(r), /3 entri performance tanpa recorded_at dibuang/);
});

test("without a cutoff the report keeps the old equity layout", () => {
  const r = fakeReport({ cutoff: null });
  const out = formatPnlReport(r);
  assert.doesNotMatch(out, /Periode: sejak/);
  assert.doesNotMatch(out, /Saldo awal/);
  assert.doesNotMatch(out, /Modal dasar/);
  assert.match(out, /Deposit netto\s+2\.0000/);
  assert.match(out, /= ekuitas - deposit - biaya LLM/);
});
