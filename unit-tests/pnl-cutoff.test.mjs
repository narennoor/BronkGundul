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

const { resolveReportCutoff, applyCutoff, formatPnlReport, classifyCashFlows } =
  await import("../pnl-report.js");

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

test("the opening balance is derived from the CURRENT balance, not the pre-cutoff sum", () => {
  // The walk stops at the cutoff, so pre-cutoff flows are only partially
  // fetched and summing them would understate the opening balance.
  const txs = [
    tx("2026-07-25T00:00:00Z", -0.5),   // agent deploy
    tx("2026-07-22T00:00:00Z", +2),     // agent-era top-up
    tx("2026-07-10T00:00:00Z", -1),     // one pre-cutoff page happened to load
  ];
  // wallet holds 9.5 now; 1.5 of that arrived after the cutoff → it held 8 before
  const r = applyCutoff({ txs, perf: [], wallet: WALLET, cutoff: CUTOFF, balance: 9.5 });
  assert.equal(r.openingBalance, 8);
  assert.equal(r.preCutoffTxs.length, 1);
  assert.deepEqual(r.inScopeTxs.map((t) => t.timestamp), [
    Math.floor(Date.parse("2026-07-25T00:00:00Z") / 1000),
    Math.floor(Date.parse("2026-07-22T00:00:00Z") / 1000),
  ]);
});

test("a wallet with no history before the cutoff gets an opening balance of 0", () => {
  const txs = [tx("2026-07-25T00:00:00Z", +3), tx("2026-07-22T00:00:00Z", +1)];
  const r = applyCutoff({ txs, perf: [], wallet: WALLET, cutoff: CUTOFF, balance: 4 });
  assert.equal(r.openingBalance, 0);
});

test("a tx exactly at the cutoff instant is IN scope", () => {
  const txs = [tx("2026-07-21T00:00:00Z", -0.3)];
  const r = applyCutoff({ txs, perf: [], wallet: WALLET, cutoff: CUTOFF, balance: 4.7 });
  assert.equal(r.inScopeTxs.length, 1);
  assert.equal(r.openingBalance, 5);
});

test("closed cycles are filtered by recorded_at; undated ones are dropped AND counted", () => {
  const perf = [
    { recorded_at: "2026-07-19T12:00:00Z", pnl_sol: -5 },  // pre-agent
    { recorded_at: "2026-08-11T05:36:17.470Z", pnl_sol: 1 },
    { recorded_at: undefined, pnl_sol: 99 },
  ];
  const r = applyCutoff({ txs: [], perf, wallet: WALLET, cutoff: CUTOFF, balance: 0 });
  assert.equal(r.perf.length, 1);
  assert.equal(r.perf[0].pnl_sol, 1);
  assert.equal(r.perfUndated, 1);
});

test("cutoff: null is the identity transform — pre-cutoff behavior is untouched", () => {
  const txs = [tx("2026-07-01T00:00:00Z", +9)];
  const perf = [{ recorded_at: undefined, pnl_sol: 3 }];
  const r = applyCutoff({ txs, perf, wallet: WALLET, cutoff: null, balance: 9 });
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
    walk: { trusted: true, snapshot_stable: true, complete: false, reached_cutoff: true, txs_walked: 40 },
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

test("an UNSET LLM baseline says the LLM cost is still lifetime", () => {
  const r = fakeReport();
  r.bridge.llm_usd_baseline = null;
  assert.match(formatPnlReport(r), /LLM masih total seumur key/);
});

test("an explicit 0 baseline is taken at face value — no nag", () => {
  // The key was created after the cutoff, so there is genuinely nothing to
  // subtract. Warning forever about a correctly-configured report is noise.
  const r = fakeReport();
  r.bridge.llm_usd_baseline = 0;
  r.bridge.llm_usd = r.bridge.llm_usd_lifetime;
  const out = formatPnlReport(r);
  assert.doesNotMatch(out, /LLM masih total seumur key/);
  assert.doesNotMatch(out, /seumur key - baseline/);
});

test("an open position deployed before the cutoff is flagged as double-counted", () => {
  const r = fakeReport();
  r.open = [{ pool: "OLD-SOL", principal: 1, outflow: 1.1, gasIn: 0.001, deployed_at: "2026-07-01T00:00:00Z", matched_by: "signature", pre_cutoff: true }];
  assert.match(formatPnlReport(r), /di-deploy SEBELUM cutoff/);
});

test("a walk that never reached the cutoff names the paging limit, not a moving balance", () => {
  const r = fakeReport();
  r.consistent = false;
  r.walk = { trusted: false, snapshot_stable: true, complete: false, reached_cutoff: false, txs_walked: 10000 };
  const out = formatPnlReport(r);
  assert.match(out, /berhenti sebelum mencapai cutoff/);
  assert.doesNotMatch(out, /Saldo berubah saat laporan dihitung/);
});

test("a balance that moved mid-report names the double count, not paging", () => {
  const r = fakeReport();
  r.consistent = false;
  r.walk = { trusted: true, snapshot_stable: false, complete: false, reached_cutoff: true, txs_walked: 40 };
  const out = formatPnlReport(r);
  assert.match(out, /terhitung DUA KALI/);
  assert.doesNotMatch(out, /berhenti sebelum mencapai cutoff/);
});

test("a full walk whose flows do not add up to the balance flags the gap", () => {
  const r = fakeReport();
  r.consistent = false;
  r.walk = { trusted: false, snapshot_stable: true, complete: true, reached_cutoff: true, txs_walked: 500 };
  assert.match(formatPnlReport(r), /ada tx yang hilang di tengah/);
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

// ── deposit / withdrawal classification ────────────────────────────
// Helius types a Meteora add-liquidity tx that wraps SOL as
// "TRANSFER/SYSTEM_PROGRAM" — indistinguishable from a real funding transfer
// unless you look at its token legs. Trusting the label booked 87.24 SOL of
// position deposits as withdrawals (26 Aug 2026).

const POOL_VAULT = "E69Pyagtw8UXvve4xQDQoR2eTG7bSYod7H2Y8RjASyM8";
const OUTSIDE = "FundingWa11et1111111111111111111111111111111";

test("a DLMM deploy typed TRANSFER is NOT a withdrawal", () => {
  // shape taken verbatim from tx 2zXrmdzY…: LBUZ program, wSOL + token legs out
  const deploy = {
    signature: "deploy1", timestamp: 1, type: "TRANSFER", feePayer: WALLET, fee: 5000,
    tokenTransfers: [
      { mint: "3BgwJ8b7", fromUserAccount: WALLET, toUserAccount: POOL_VAULT, tokenAmount: 374.5 },
      { mint: "So111111", fromUserAccount: WALLET, toUserAccount: POOL_VAULT, tokenAmount: 0.575 },
    ],
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: POOL_VAULT, amount: 0.575e9 }],
  };
  const r = classifyCashFlows([deploy], WALLET);
  assert.equal(r.withdrawOut, 0);
  assert.equal(r.depositIn, 0);
  // gas is still charged — the token check must not skip the fee
  assert.equal(r.gasSol, 5000 / 1e9);
  assert.equal(r.gasTxn, 1);
});

test("a pure SOL funding transfer in IS a deposit", () => {
  // shape taken verbatim from tx 2Vd95gQ8…: system program only, no token legs
  const funding = {
    signature: "fund1", timestamp: 1, type: "TRANSFER", feePayer: OUTSIDE, fee: 5000,
    tokenTransfers: [],
    nativeTransfers: [{ fromUserAccount: OUTSIDE, toUserAccount: WALLET, amount: 5.4586e9 }],
  };
  const r = classifyCashFlows([funding], WALLET);
  assert.equal(r.depositIn, 5.4586);
  assert.equal(r.withdrawOut, 0);
  assert.equal(r.gasTxn, 0);   // someone else paid
});

test("a pure SOL transfer out IS a withdrawal", () => {
  const cashOut = {
    signature: "out1", timestamp: 1, type: "TRANSFER", feePayer: WALLET, fee: 5000,
    tokenTransfers: [],
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OUTSIDE, amount: 2e9 }],
  };
  assert.equal(classifyCashFlows([cashOut], WALLET).withdrawOut, 2);
});

test("an RFQ swap fill paying SOL in is NOT a deposit", () => {
  const fill = {
    signature: "fill1", timestamp: 1, type: "SWAP", feePayer: POOL_VAULT, fee: 5000,
    tokenTransfers: [{ mint: "3BgwJ8b7", fromUserAccount: WALLET, toUserAccount: POOL_VAULT, tokenAmount: 100 }],
    nativeTransfers: [{ fromUserAccount: POOL_VAULT, toUserAccount: WALLET, amount: 1.2e9 }],
  };
  assert.equal(classifyCashFlows([fill], WALLET).depositIn, 0);
});

test("dust below the 0.005 SOL floor is ignored on both sides", () => {
  const dust = {
    signature: "dust1", timestamp: 1, type: "TRANSFER", feePayer: WALLET, fee: 5000,
    tokenTransfers: [],
    nativeTransfers: [
      { fromUserAccount: WALLET, toUserAccount: OUTSIDE, amount: 4e6 },
      { fromUserAccount: OUTSIDE, toUserAccount: WALLET, amount: 4e6 },
    ],
  };
  const r = classifyCashFlows([dust], WALLET);
  assert.equal(r.withdrawOut, 0);
  assert.equal(r.depositIn, 0);
});

test("position rent — a token-free SOL outflow — is not counted as a withdrawal", () => {
  const rent = {
    signature: "rent1", timestamp: 1, type: "INITIALIZE_POSITION", feePayer: WALLET, fee: 5000,
    tokenTransfers: [],
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: POOL_VAULT, amount: 0.109e9 }],
  };
  assert.equal(classifyCashFlows([rent], WALLET).withdrawOut, 0);
});
