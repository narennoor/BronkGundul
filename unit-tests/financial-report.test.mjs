// Fase 2 — seal mingguan/bulanan + laporan (equity-snapshot.sealPeriod,
// financial-report.js).
//
// Mandated by the design:
//   (d) the seal chain: saldo_awal[N] == total_ekuitas[N−1], PER period kind,
//       and a broken chain LABELS the record (assertion 7) instead of throwing,
//   (e) sealPeriod refuses to overwrite an existing seal (immutable) unless
//       reseal is explicit,
//   (a) still: the whole seal/report path is pure arithmetic over local files —
//       the fetch stub below THROWS on any call, and the suite ends by
//       asserting zero calls happened.
//
// The ledger here is synthetic and hand-computable: 2026-06-29 (a Monday,
// 2026-W27) through 2026-09-01, one deposit (Jul 10), one withdrawal (Aug 5),
// constant gas/book rows, no drift. All sealPeriod calls pin `now` so the
// suite stays deterministic forever.

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

// The entire fase-2 path must never touch the network.
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls++;
  throw new Error(`zero-walk violated: fetch(${String(url).slice(0, 80)})`);
};

const {
  sealPeriod,
  loadPeriods,
  loadSnapshots,
  periodBounds,
  periodIdFor,
  prevPeriodId,
  lastClosedPeriodId,
  isoWeekIdFor,
  snapshotIdFor,
} = await import("../equity-snapshot.js");
const { buildPeriodReport, ensurePeriodSealed, formatFinancialReport } = await import("../financial-report.js");
const { writeJsonAtomic, readJsonStore } = await import("../utils/json-store.js");

const DAY = 24 * 3600 * 1000;
const B_START = Date.parse("2026-06-29T00:00:00Z"); // Monday, 2026-W27
const B_END = Date.parse("2026-09-01T00:00:00Z");
const NOW = Date.parse("2026-09-02T00:30:00Z"); // pinned — the suite never ages
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// ── synthetic, hand-computable ledger ────────────────────────────────
{
  const snapshots = [];
  let saldo = 10;
  let i = 0;
  for (let b = B_START; b <= B_END; b += DAY, i++) {
    const id = snapshotIdFor(b);
    const first = b === B_START;
    const windowDay = snapshotIdFor(b - DAY);
    const dep = windowDay === "2026-07-10" ? 2 : 0;
    const wd = windowDay === "2026-08-05" ? 1 : 0;
    const gas = first ? 0 : 0.001;
    const bookNet = first ? 0 : 0.002;
    // the last window opens a position: 0.7 SOL leaves the free balance and
    // sits at cost (principal 0.6 + rent 0.1)
    const posOut = id === "2026-09-01" ? 0.7 : 0;
    const modal = id === "2026-09-01" ? 0.7 : 0;
    const flowSum = first ? 0 : r9(dep - wd - gas + bookNet - posOut);
    const prevSaldo = first ? null : saldo;
    saldo = r9(saldo + flowSum);
    const transfers = [];
    if (dep) transfers.push({ sig: `dep-${windowDay}`, ts: (b - DAY + 12 * 3600 * 1000) / 1000, dir: "in", counterparty: "EXT", amount_sol: dep });
    if (wd) transfers.push({ sig: `wd-${windowDay}`, ts: (b - DAY + 12 * 3600 * 1000) / 1000, dir: "out", counterparty: "EXT", amount_sol: wd });
    snapshots.push({
      id,
      boundary_ts: isoZ(b),
      taken_at: new Date(b + 5 * 60 * 1000).toISOString(),
      source: first ? "genesis" : "light",
      equity: {
        saldo_bebas_sol: saldo,
        modal_posisi_sol: modal,
        principal_sol: modal ? 0.6 : 0,
        rent_sol: modal ? 0.1 : 0,
        total_sol: r9(saldo + modal),
      },
      market_memo: { nilai_pasar_sol: id === "2026-09-01" ? 0.5 : 0, suspect: false },
      flows: { deposit_in_sol: dep, withdraw_out_sol: wd, gas_sol: gas, gas_txn: first ? 0 : 3, transfers },
      book: {
        closed: first ? 0 : 1,
        wins: first ? 0 : i % 2,
        fee_lp_sol: first ? 0 : 0.003,
        net_revenue_sol: bookNet,
        liquidation_gap_sol: first ? 0 : -0.0001,
      },
      sol_price: 200,
      llm_usd_lifetime: r9(10 + 0.05 * i),
      llm_key_id: "unittest1",
      integrity: {
        delta_balance_sol: first ? null : flowSum,
        flow_sum_sol: first ? 0 : flowSum,
        drift_sol: first ? null : 0,
        trusted: true,
        txs: first ? 0 : 3,
      },
      window_sigs: [],
    });
  }
  const file = ledgerPath(WALLET, "snapshots.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { version: 1, address: WALLET, snapshots });
}

// ── period helpers ───────────────────────────────────────────────────

test("ISO week & month bounds: Monday 00:00Z, half-open, W35 == Aug 24", () => {
  assert.equal(isoWeekIdFor(Date.parse("2026-08-27T13:00:00Z")), "2026-W35");
  const w35 = periodBounds("week", "2026-W35");
  assert.equal(isoZ(w35.from), "2026-08-24T00:00:00Z");
  assert.equal(isoZ(w35.to), "2026-08-31T00:00:00Z");
  const aug = periodBounds("month", "2026-08");
  assert.equal(isoZ(aug.from), "2026-08-01T00:00:00Z");
  assert.equal(isoZ(aug.to), "2026-09-01T00:00:00Z");
  assert.equal(prevPeriodId("week", "2026-W01"), "2025-W52"); // crosses the year (2025 has 52 ISO weeks)
  assert.equal(prevPeriodId("month", "2026-01"), "2025-12");
  assert.equal(lastClosedPeriodId("week", NOW), "2026-W35");
  assert.equal(lastClosedPeriodId("month", NOW), "2026-08");
  assert.throws(() => periodBounds("week", "2026-08"), /tidak valid/);
  // fase 3: kind "year" is supported
  const y = periodBounds("year", "2026");
  assert.equal(isoZ(y.from), "2026-01-01T00:00:00Z");
  assert.equal(isoZ(y.to), "2027-01-01T00:00:00Z");
  assert.equal(prevPeriodId("year", "2026"), "2025");
  assert.throws(() => periodBounds("kuartal", "2026-Q1"), /tidak dikenal/);
});

// ── month seals: fold values + chain (test d, month lane) ────────────

test("seal Juli & Agustus: fold benar, rantai bulanan nyambung, integrity_ok", () => {
  const jul = sealPeriod("month", "2026-07", { now: NOW });
  assert.equal(jul.prev_seal_id, null); // first month seal — no chain, no flag
  assert.equal(jul.integrity.integrity_ok, true);
  assert.deepEqual(jul.integrity.assertions_failed, []);
  close(jul.equity.deposit_sol, 2);
  close(jul.pnl.gas_fee_sol, -0.031);

  const aug = sealPeriod("month", "2026-08", { now: NOW });
  assert.equal(aug.prev_seal_id, "2026-07");
  // the chain (assertion 7): saldo_awal == total_ekuitas of the previous seal
  close(aug.equity.saldo_awal_sol, jul.equity.total_ekuitas_sol);
  assert.equal(aug.integrity.integrity_ok, true);

  // hand-computed August: 31 windows, one −1 withdrawal, 0.001 gas/day,
  // 0.003 fee & 0.002 net_revenue/day
  assert.equal(aug.integrity.windows, 31);
  assert.equal(aug.integrity.all_trusted, true);
  close(aug.equity.withdrawal_sol, -1);
  close(aug.equity.deposit_sol, 0);
  close(aug.pnl.gas_fee_sol, -0.031);
  close(aug.pnl.fee_lp_sol, 0.093);
  close(aug.pnl.net_revenue_sol, 0.062);
  close(aug.pnl.impermanent_loss_sol, -0.031);
  close(aug.pnl.exec_cost_measured_sol, -0.0031);
  close(aug.pnl.gross_rill_sol, 0.031);
  close(aug.pnl.exec_cost_sol, 0); // every flow accounted → the plug is 0
  close(aug.equity.laba_kumulatif_sol, aug.pnl.gross_rill_sol); // ≡ Gross Rill
  assert.equal(aug.pnl.closes, 31);
  // LLM: lifetime diff of the endpoints (31 days × 0.05), priced at close
  close(aug.pnl.llm_cost_usd, -1.55);
  close(aug.pnl.llm_cost_sol, -1.55 / 200);
  close(aug.pnl.net_rill_sol, r9(0.031 - 1.55 / 200));
  // closing endpoint carries the at-cost position + market memo
  close(aug.equity.modal_posisi_sol, 0.7);
  close(aug.equity.modal_posisi_rent_sol, 0.1);
  close(aug.equity.unrealized_pnl_sol, -0.2); // memo 0.5 − modal 0.7
  assert.equal(aug.equity.unrealized_suspect, false);
  assert.equal(aug.sol_price_close, 200);
  assert.match(aug.snapshots_hash, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(aug.roi.dietz_pct));
  assert.ok(Number.isFinite(aug.roi.twr_pct));
  assert.ok(aug.roi.dietz_pct > 0 && aug.roi.dietz_pct < 1);
});

// ── test e: seals are immutable ──────────────────────────────────────

test("test e — sealPeriod menolak menimpa seal yang sudah ada; reseal eksplisit boleh", () => {
  assert.throws(() => sealPeriod("month", "2026-08", { now: NOW }), /sudah ada.*immutable/s);
  const before = loadPeriods(WALLET).periods.length;
  const resealed = sealPeriod("month", "2026-08", { now: NOW + 60_000, reseal: true });
  const store = loadPeriods(WALLET);
  assert.equal(store.periods.length, before); // replaced, not duplicated
  assert.equal(resealed.sealed_at, new Date(NOW + 60_000).toISOString());
  close(resealed.pnl.gross_rill_sol, 0.031); // same data → same numbers
});

// ── test d: week lane chains independently; a broken chain LABELS ────

test("test d — rantai mingguan: nyambung saat benar, assertion 7 melabel saat putus", () => {
  const w32 = sealPeriod("week", "2026-W32", { now: NOW });
  // weeks chain to weeks — the month seals above are a separate lane
  assert.equal(w32.prev_seal_id, null);
  assert.equal(w32.integrity.integrity_ok, true);
  assert.equal(w32.integrity.windows, 7);
  close(w32.pnl.fee_lp_sol, 0.021);
  close(w32.equity.withdrawal_sol, -1); // Aug 5 falls in W32 (Aug 3–10)

  const w33 = sealPeriod("week", "2026-W33", { now: NOW });
  assert.equal(w33.prev_seal_id, "2026-W32");
  close(w33.equity.saldo_awal_sol, w32.equity.total_ekuitas_sol);
  assert.equal(w33.integrity.integrity_ok, true);

  // ensurePeriodSealed on an existing seal returns it untouched
  const ensured = ensurePeriodSealed("week", "2026-W33");
  assert.equal(ensured.sealedNow, false);
  assert.equal(ensured.record.sealed_at, w33.sealed_at);

  // tamper W33's sealed total → the NEXT seal must flag the chain, not throw
  const file = ledgerPath(WALLET, "periods.json");
  const store = readJsonStore(file, null);
  const rec = store.periods.find((p) => p.kind === "week" && p.id === "2026-W33");
  rec.equity.total_ekuitas_sol = r9(rec.equity.total_ekuitas_sol + 0.5);
  writeJsonAtomic(file, store);

  const w34 = sealPeriod("week", "2026-W34", { now: NOW });
  assert.equal(w34.prev_seal_id, "2026-W33");
  assert.equal(w34.integrity.integrity_ok, false);
  assert.ok(w34.integrity.assertions_failed.some((a) => a.startsWith("7:")), w34.integrity.assertions_failed.join("; "));
  // everything else about W34 is still healthy — one label, not a refusal
  assert.equal(w34.integrity.assertions_failed.length, 1);
  close(w34.pnl.fee_lp_sol, 0.021);
});

// ── refusal cases that SHOULD throw: not-closed, bad id, missing endpoint ──

test("periode berjalan & bahan mentah hilang menolak segel dengan jelas", () => {
  assert.throws(() => sealPeriod("week", periodIdFor("week", NOW), { now: NOW }), /belum tutup/);
  assert.throws(() => sealPeriod("month", "2026-13", { now: NOW }), /tidak valid/);
  // W26 (Jun 22–29): opening boundary 2026-06-22 predates the ledger
  assert.throws(() => sealPeriod("week", "2026-W26", { now: NOW }), /belum ada di ledger/);
});

// ── missing interior window: label, publish anyway ───────────────────

test("snapshot bolong di tengah minggu → windows flag + integrity_ok false, tanpa throw", () => {
  const file = ledgerPath(WALLET, "snapshots.json");
  const store = readJsonStore(file, null);
  store.snapshots = store.snapshots.filter((s) => s.id !== "2026-08-28"); // inside W35
  writeJsonAtomic(file, store);

  const w35 = sealPeriod("week", "2026-W35", { now: NOW });
  assert.equal(w35.integrity.integrity_ok, false);
  assert.ok(w35.integrity.assertions_failed.some((a) => a.startsWith("windows:6/7")));
  // chain to W34 is still verified and fine (its record was not tampered)
  assert.ok(!w35.integrity.assertions_failed.some((a) => a.startsWith("7:")));
  // sums are short one day — the plug row absorbs it, identities still hold
  close(w35.pnl.fee_lp_sol, 0.018);
  close(w35.pnl.gross_rill_sol, r9(w35.pnl.net_revenue_sol + w35.pnl.exec_cost_sol + w35.pnl.gas_fee_sol));
});

// ── buildPeriodReport + formatFinancialReport ────────────────────────

test("buildPeriodReport membaca seal; yang belum ada menolak dengan petunjuk", () => {
  const r = buildPeriodReport({ kind: "month", id: "2026-08" });
  assert.equal(r.wallet, WALLET);
  assert.equal(r.record.id, "2026-08");
  assert.throws(() => buildPeriodReport({ kind: "month", id: "2025-01" }), /Belum ada seal/);
});

test("formatFinancialReport: tata letak §06, USD turunan, label integritas", () => {
  const clean = buildPeriodReport({ kind: "month", id: "2026-08" });
  const txt = formatFinancialReport(clean);
  assert.match(txt, /Laporan Bulanan — Agustus 2026/);
  assert.match(txt, /Fee LP\s+\+0\.0930/);
  assert.match(txt, /Impermanent loss\s+-0\.0310/);
  assert.match(txt, /Gas fee\s+-0\.0310/);
  assert.match(txt, /NET RILL/);
  assert.match(txt, /Saldo awal/);
  assert.match(txt, /Withdrawal\s+-1\.0000/);
  assert.match(txt, /Laba kumulatif\s+\+0\.0310\s+✓ ≡ Gross Rill/);
  assert.match(txt, /blm direalisasi\s+-0\.2000/);
  assert.match(txt, /ROI periode \(Dietz\)/);
  assert.match(txt, /Window 31\/31 ✓/);
  assert.match(txt, /USD turunan @ 200\.00/);
  assert.doesNotMatch(txt, /⚠️ INTEGRITAS/);

  const html = formatFinancialReport(clean, { html: true });
  assert.match(html, /^<b>📒 Laporan Bulanan — Agustus 2026<\/b>\n<pre>/);
  assert.match(html, /<\/pre>$/);

  // the labeled W35 report publishes WITH its label
  const flagged = buildPeriodReport({ kind: "week", id: "2026-W35" });
  const ftxt = formatFinancialReport(flagged);
  assert.match(ftxt, /Laporan Mingguan — 2026-W35/);
  assert.match(ftxt, /Window 6\/7 ✗/);
  assert.match(ftxt, /⚠️ INTEGRITAS: 1 cek gagal/);
  assert.match(ftxt, /windows:6\/7/);
});

// ── the zero-walk rule, end to end ───────────────────────────────────

test("test a — seluruh jalur seal + laporan fase 2: NOL panggilan jaringan", () => {
  assert.equal(fetchCalls, 0, "sealing/reporting must never call Helius/RPC/price APIs");
});
