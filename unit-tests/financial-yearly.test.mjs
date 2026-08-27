// Fase 3 — seal tahunan + YTD (assertion 10, aturan fold §04, urutan 1 Jan).
//
// Mandated by the design:
//   - the year seal passes assertion 10 against 12 monthly seals on a
//     hand-computable full-year dataset, and a tampered month seal LABELS the
//     year record (never throws),
//   - /report ytd semantics: never sealed, composed of closed-month seals +
//     the running month folded straight from snapshots, fold rules §04 exact
//     (additive summed, endpoints taken, modal_dasar/win_rate/Dietz
//     recomputed, TWR chained multiplicatively), sigma check between its two
//     computation lanes,
//   - the 1 Januari ordering: the year path seals a leftover December FIRST —
//     tested by deleting the December seal and watching ensurePeriodSealed
//     restore it before the year record is computed,
//   - and, as everywhere on this path: ZERO network calls (the fetch stub
//     throws; the suite ends by asserting no call ever happened).

import { ledgerPath } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

process.env.RPC_URL = "http://unit-test.invalid/rpc";
process.env.HELIUS_API_KEY = "unit-test-helius-key";
process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";

const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const kp = Keypair.generate();
process.env.WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey);
const WALLET = kp.publicKey.toString();

let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls++;
  throw new Error(`zero-walk violated: fetch(${String(url).slice(0, 80)})`);
};

const {
  sealPeriod,
  loadPeriods,
  periodBounds,
  periodIdFor,
  lastClosedPeriodId,
  snapshotIdFor,
} = await import("../equity-snapshot.js");
const { buildPeriodReport, buildYtdReport, ensurePeriodSealed, formatFinancialReport } =
  await import("../financial-report.js");
const { writeJsonAtomic, readJsonStore } = await import("../utils/json-store.js");

const DAY = 24 * 3600 * 1000;
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

const SEAL_NOW = Date.parse("2027-01-02T00:00:00Z"); // everything 2026 is closed
const ORDER_NOW = Date.parse("2027-01-01T00:35:00Z"); // the yearly cron instant
const YTD_NOW = Date.parse("2026-09-15T12:00:00Z"); // mid-September

// Deterministic ledger: constant gas 0.001 / fee 0.003 / net_revenue 0.002
// per day, one +2 deposit (window day 2026-03-10), one −1 withdrawal (window
// day 2026-09-05), llm lifetime +0.05/day at price 200, no open positions.
function writeLedger(startIso, endIso, { deposits = {}, withdrawals = {} } = {}) {
  const B0 = Date.parse(startIso);
  const BN = Date.parse(endIso);
  const snapshots = [];
  let saldo = 10;
  let i = 0;
  for (let b = B0; b <= BN; b += DAY, i++) {
    const id = snapshotIdFor(b);
    const first = b === B0;
    const windowDay = snapshotIdFor(b - DAY);
    const dep = deposits[windowDay] || 0;
    const wd = withdrawals[windowDay] || 0;
    const gas = first ? 0 : 0.001;
    const net = first ? 0 : 0.002;
    const flowSum = first ? 0 : r9(dep - wd - gas + net);
    saldo = r9(saldo + flowSum);
    const transfers = [];
    if (dep) transfers.push({ sig: `dep-${windowDay}`, ts: (b - DAY + 43200000) / 1000, dir: "in", counterparty: "EXT", amount_sol: dep });
    if (wd) transfers.push({ sig: `wd-${windowDay}`, ts: (b - DAY + 43200000) / 1000, dir: "out", counterparty: "EXT", amount_sol: wd });
    snapshots.push({
      id,
      boundary_ts: isoZ(b),
      taken_at: new Date(b + 300000).toISOString(),
      source: first ? "genesis" : "light",
      equity: { saldo_bebas_sol: saldo, modal_posisi_sol: 0, principal_sol: 0, rent_sol: 0, total_sol: saldo },
      market_memo: { nilai_pasar_sol: 0, suspect: false },
      flows: { deposit_in_sol: dep, withdraw_out_sol: wd, gas_sol: gas, gas_txn: first ? 0 : 3, transfers },
      book: { closed: first ? 0 : 1, wins: first ? 0 : i % 2, fee_lp_sol: first ? 0 : 0.003, net_revenue_sol: net, liquidation_gap_sol: first ? 0 : -0.0001 },
      sol_price: 200,
      llm_usd_lifetime: r9(10 + 0.05 * i),
      llm_key_id: "unittest1",
      integrity: { delta_balance_sol: first ? null : flowSum, flow_sum_sol: first ? 0 : flowSum, drift_sol: first ? null : 0, trusted: true, txs: first ? 0 : 3 },
      window_sigs: [],
    });
  }
  const file = ledgerPath(WALLET, "snapshots.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { version: 1, address: WALLET, snapshots });
}

writeLedger("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", {
  deposits: { "2026-03-10": 2 },
  withdrawals: { "2026-09-05": 1 },
});

test("kind year: bounds, id, dan lastClosedPeriodId pada 1 Januari", () => {
  const y = periodBounds("year", "2026");
  assert.equal(isoZ(y.from), "2026-01-01T00:00:00Z");
  assert.equal(isoZ(y.to), "2027-01-01T00:00:00Z");
  assert.equal(periodIdFor("year", Date.parse("2026-08-27T13:00:00Z")), "2026");
  // 1 Januari: minggu/bulan/tahun yang baru tutup, semua konsisten
  assert.equal(lastClosedPeriodId("month", ORDER_NOW), "2026-12");
  assert.equal(lastClosedPeriodId("year", ORDER_NOW), "2026");
});

test("assertion 10: seal tahunan cocok dengan Σ 12 seal bulanan (data uji 12 bulan)", () => {
  // seal the 12 months ascending — each chains to the previous
  let prevTotal = null;
  for (let m = 1; m <= 12; m++) {
    const id = `2026-${String(m).padStart(2, "0")}`;
    const rec = sealPeriod("month", id, { now: SEAL_NOW });
    assert.equal(rec.integrity.integrity_ok, true, `${id}: ${rec.integrity.assertions_failed.join("; ")}`);
    if (prevTotal != null) close(rec.equity.saldo_awal_sol, prevTotal);
    prevTotal = rec.equity.total_ekuitas_sol;
  }

  const year = sealPeriod("year", "2026", { now: SEAL_NOW });
  assert.equal(year.kind, "year");
  assert.equal(year.prev_seal_id, null); // first year seal
  assert.equal(year.integrity.integrity_ok, true, year.integrity.assertions_failed.join("; "));
  assert.equal(year.integrity.windows, 365); // 2026 is not a leap year

  // hand-computed 2026: 365 windows × (gas 0.001, fee 0.003, net 0.002),
  // one +2 deposit, one −1 withdrawal
  close(year.pnl.fee_lp_sol, 1.095);
  close(year.pnl.net_revenue_sol, 0.73);
  close(year.pnl.impermanent_loss_sol, -0.365);
  close(year.pnl.gas_fee_sol, -0.365);
  close(year.equity.deposit_sol, 2);
  close(year.equity.withdrawal_sol, -1);
  close(year.pnl.gross_rill_sol, 0.365);
  close(year.pnl.exec_cost_sol, 0);
  close(year.pnl.llm_cost_usd, -18.25); // 365 × 0.05
  close(year.pnl.llm_cost_sol, -18.25 / 200);
  close(year.pnl.net_rill_sol, r9(0.365 - 18.25 / 200));
  assert.equal(year.pnl.closes, 365);
  assert.equal(year.pnl.wins, 183); // Σ (i % 2), i = 1..365
  close(year.equity.saldo_awal_sol, 10);
  close(year.equity.modal_dasar_sol, 11);
  close(year.equity.laba_kumulatif_sol, 0.365);
  assert.match(year.snapshots_hash, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(year.roi.dietz_pct) && Number.isFinite(year.roi.twr_pct));
});

test("assertion 10 melabel seal bulanan yang di-tamper — tidak pernah throw", () => {
  const file = ledgerPath(WALLET, "periods.json");
  const store = readJsonStore(file, null);
  const jun = store.periods.find((p) => p.kind === "month" && p.id === "2026-06");
  jun.pnl.fee_lp_sol = r9(jun.pnl.fee_lp_sol + 0.01);
  writeJsonAtomic(file, store);

  const year = sealPeriod("year", "2026", { now: SEAL_NOW, reseal: true });
  assert.equal(year.integrity.integrity_ok, false);
  assert.ok(year.integrity.assertions_failed.some((a) => a.startsWith("10:fee_lp_sol")),
    year.integrity.assertions_failed.join("; "));

  // restore + clean reseal so later tests see a healthy chain
  const store2 = readJsonStore(file, null);
  const jun2 = store2.periods.find((p) => p.kind === "month" && p.id === "2026-06");
  jun2.pnl.fee_lp_sol = r9(jun2.pnl.fee_lp_sol - 0.01);
  writeJsonAtomic(file, store2);
  const clean = sealPeriod("year", "2026", { now: SEAL_NOW, reseal: true });
  assert.equal(clean.integrity.integrity_ok, true);
});

test("/report ytd: seal bulan tertutup + fold bulan berjalan, aturan fold §04, sigma ✓", () => {
  const ytd = buildYtdReport({ year: 2026, now: YTD_NOW });
  assert.equal(ytd.id, "2026-YTD");
  assert.equal(ytd.kind, "ytd");
  // never sealed: stamped as_of, no sealed_at, no snapshots_hash, and it must
  // never have entered periods.json
  assert.equal(ytd.sealed_at, undefined);
  assert.equal(ytd.snapshots_hash, undefined);
  assert.equal(typeof ytd.as_of, "string");
  assert.ok(!loadPeriods(WALLET).periods.some((p) => p.kind === "ytd" || String(p.id).includes("YTD")));

  // September is RUNNING at Sep 15 even though its seal exists — only closed
  // months come from seals (8: Jan..Aug)
  assert.equal(ytd.months_sealed, 8);
  assert.equal(isoZ(Date.parse(ytd.to)), "2026-09-15T00:00:00Z");
  assert.equal(ytd.integrity.windows, 257); // 243 sealed + 14 running

  // additive rows: 257 window days, dep Mar 10, wd Sep 5 (running month)
  close(ytd.pnl.fee_lp_sol, 0.771);
  close(ytd.pnl.net_revenue_sol, 0.514);
  close(ytd.pnl.gas_fee_sol, -0.257);
  close(ytd.equity.deposit_sol, 2);
  close(ytd.equity.withdrawal_sol, -1);
  close(ytd.pnl.gross_rill_sol, 0.257);
  close(ytd.pnl.exec_cost_sol, 0);
  assert.equal(ytd.pnl.closes, 257);
  assert.equal(ytd.pnl.wins, 129); // Σ (i % 2), i = 1..257
  close(ytd.pnl.llm_cost_usd, -12.85); // 8 bulan (12.15) + 14 hari berjalan (0.70)
  // recomputed rows (§04): modal_dasar & laba from endpoints, never summed
  close(ytd.equity.saldo_awal_sol, 10);
  close(ytd.equity.modal_dasar_sol, 11);
  close(ytd.equity.total_ekuitas_sol, 11.257);
  close(ytd.equity.laba_kumulatif_sol, 0.257);
  // TWR chained multiplicatively; Dietz recomputed from exact flow timings
  assert.ok(Number.isFinite(ytd.roi.twr_pct) && ytd.roi.twr_pct > 0);
  assert.ok(ytd.roi.dietz_pct > 0 && ytd.roi.dietz_pct < 5);
  // the running assertion 10: both computation lanes meet
  assert.equal(ytd.integrity.sigma_ok, true);
  assert.equal(ytd.integrity.integrity_ok, true, ytd.integrity.assertions_failed.join("; "));
});

test("strip YTD di laporan bulanan + laporan YTD/tahunan berdiri sendiri", () => {
  const aug = buildPeriodReport({ kind: "month", id: "2026-08" });
  const ytd = buildYtdReport({ year: 2026, now: YTD_NOW });
  const txt = formatFinancialReport({ ...aug, ytd });
  assert.match(txt, /YTD BERJALAN · 2026-01-01 → 2026-09-15/);
  assert.match(txt, /ROI YTD \(Dietz\)/);
  assert.match(txt, /8 bulan tersegel · as of/);
  assert.match(txt, /Σ 8 seal bulanan ≡ YTD ✓/);

  const ytdTxt = formatFinancialReport({ wallet: WALLET, record: ytd });
  assert.match(ytdTxt, /Laporan YTD 2026 \(berjalan\)/);
  assert.match(ytdTxt, /as of 2026-09-15/);
  assert.match(ytdTxt, /Bulan tersegel 8 · window 257/);
  assert.match(ytdTxt, /Σ 8 seal bulanan ≡ fold snapshot ✓/);
  assert.doesNotMatch(ytdTxt, /disegel/);

  const yearTxt = formatFinancialReport(buildPeriodReport({ kind: "year", id: "2026" }));
  assert.match(yearTxt, /Laporan Tahunan — 2026/);
  assert.match(yearTxt, /Window 365\/365 ✓/);
});

test("urutan 1 Januari: jalur tahunan menyegel Desember yang tertinggal LEBIH DULU", () => {
  // simulate a daemon that slept through 00:30: December + year seals gone
  const file = ledgerPath(WALLET, "periods.json");
  const store = readJsonStore(file, null);
  store.periods = store.periods.filter(
    (p) => !(p.kind === "year" && p.id === "2026") && !(p.kind === "month" && p.id === "2026-12"),
  );
  writeJsonAtomic(file, store);

  const { record: year, sealedNow } = ensurePeriodSealed("year", "2026", { now: ORDER_NOW });
  assert.equal(sealedNow, true);
  // December was sealed BEFORE the year record was computed…
  const dec = loadPeriods(WALLET).periods.find((p) => p.kind === "month" && p.id === "2026-12");
  assert.ok(dec, "December must be sealed by the year path");
  assert.equal(dec.prev_seal_id, "2026-11");
  assert.equal(dec.integrity.integrity_ok, true);
  // …so assertion 10 sees all 12 months: no 10-labels, no partial-count label
  assert.equal(year.integrity.integrity_ok, true, year.integrity.assertions_failed.join("; "));
  assert.ok(!year.integrity.assertions_failed.some((a) => a.startsWith("10:")));
});

test("YTD pada ledger yang mulai di tengah tahun (kasus Bronk): parsial berlabel, sigma tetap ✓", () => {
  // replace the ledger with a mid-year one: genesis 20 Aug, data through 15 Sep
  writeLedger("2026-08-20T00:00:00Z", "2026-09-15T00:00:00Z");
  writeJsonAtomic(ledgerPath(WALLET, "periods.json"), { version: 1, address: WALLET, periods: [] });

  const ytd = buildYtdReport({ year: 2026, now: YTD_NOW });
  assert.equal(ytd.months_sealed, 0);
  close(ytd.equity.saldo_awal_sol, 10); // anchored on genesis, not a phantom Jan 1
  // 26 window days (Aug 20 → Sep 14), no deposits/withdrawals
  assert.equal(ytd.integrity.windows, 26);
  close(ytd.pnl.gross_rill_sol, 0.026);
  close(ytd.pnl.llm_cost_usd, -1.3);
  // honest labels: August partial (ledger starts mid-month) and unsealed
  assert.equal(ytd.integrity.integrity_ok, false);
  assert.ok(ytd.integrity.assertions_failed.some((a) => a.includes("2026-08 parsial")));
  assert.ok(ytd.integrity.assertions_failed.some((a) => a.includes("belum disegel")));
  // …but the two lanes still meet — the data itself is coherent
  assert.equal(ytd.integrity.sigma_ok, true);
});

test("nol-walk fase 3: seluruh jalur tahunan + YTD tidak menyentuh jaringan", () => {
  assert.equal(fetchCalls, 0);
});
