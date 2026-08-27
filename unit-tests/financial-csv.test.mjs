// Fase 4 — lampiran CSV §09 (financial-csv.js).
//
// Mandated by the design:
//   (a) meridian_periods.csv: kolom PERSIS §09 (urutan dan nama), satu berkas
//       untuk semua jenis (kolom kind), YTD tidak pernah masuk,
//   (b) UTF-8 DENGAN BOM + CRLF (Excel Windows), sel kosong ≠ nol,
//   (c) closes: filter recorded_at yang sama dengan bookEntriesIn (baris ≡
//       pnl.closes), fees_sol era-USD → sel kosong bukan konversi,
//   (d) curve: granularitas day = semua boundary, week = Senin + kedua ujung,
//   (e) komposisi lampiran per jenis: week → periods+closes; month → +curve
//       harian; ytd → periods+curve mingguan TANPA closes,
//   (f) seluruh jalur CSV nol network (aturan nol-walk).
//
// Ledger sintetisnya identik dengan financial-report.test.mjs (2026-06-29 →
// 2026-09-01, deposit 10 Jul, withdrawal 5 Agu) supaya angkanya tetap
// hand-computable dan cocok dengan angka di seal.

import { ledgerPath, statePath } from "./_setup.mjs";
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

// The entire CSV path must never touch the network.
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls++;
  throw new Error(`zero-walk violated: fetch(${String(url).slice(0, 80)})`);
};

const { sealPeriod, snapshotIdFor } = await import("../equity-snapshot.js");
const { buildYtdReport } = await import("../financial-report.js");
const {
  PERIODS_CSV_COLUMNS,
  CLOSES_CSV_COLUMNS,
  CURVE_CSV_COLUMNS,
  toPeriodsCsv,
  toClosesCsv,
  closesInWindow,
  toCurveCsv,
  buildReportCsvs,
} = await import("../financial-csv.js");
const { config } = await import("../config.js");
const { writeJsonAtomic } = await import("../utils/json-store.js");

const DAY = 24 * 3600 * 1000;
const B_START = Date.parse("2026-06-29T00:00:00Z"); // Monday, 2026-W27
const B_END = Date.parse("2026-09-01T00:00:00Z");
const NOW = Date.parse("2026-09-02T00:30:00Z");
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// ── ledger sintetis (identik dengan financial-report.test.mjs) ───────
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
    const posOut = id === "2026-09-01" ? 0.7 : 0;
    const modal = id === "2026-09-01" ? 0.7 : 0;
    const flowSum = first ? 0 : r9(dep - wd - gas + bookNet - posOut);
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

// ── bookkeeping sintetis (lessons.json) untuk closes CSV ─────────────
// e2 sengaja tanpa fees_earned_sol (era USD-only) dan dengan koma di nama
// pair (uji escaping); e3 di luar window Agustus; e4 di performance_archive
// (union readPerformanceEntries).
const PERF = [
  {
    pool: "PoolAddr1111111111111111111111111111111111", pool_name: "FOO-SOL",
    deployed_at: "2026-08-10T08:00:00.000Z", closed_at: "2026-08-10T11:58:00.000Z",
    recorded_at: "2026-08-10T11:58:01.000Z", minutes_held: 238,
    pnl_sol: 0.05, fees_earned_sol: 0.012, pnl_usd: 10.0,
    close_reason: "trailing take profit", range_efficiency: 97.3,
  },
  {
    pool: "PoolAddr2222222222222222222222222222222222", pool_name: 'BAR,BAZ"X"-SOL',
    deployed_at: "2026-08-20T01:00:00.000Z", closed_at: "2026-08-20T03:00:00.000Z",
    recorded_at: "2026-08-20T03:00:02.000Z", minutes_held: 120,
    pnl_sol: -0.02, pnl_usd: -4.0,
    close_reason: "stop loss", range_efficiency: 88,
  },
  {
    pool: "PoolAddr3333333333333333333333333333333333", pool_name: "JUL-SOL",
    deployed_at: "2026-07-15T00:00:00.000Z", recorded_at: "2026-07-15T05:00:00.000Z",
    minutes_held: 300, pnl_sol: 0.01, fees_earned_sol: 0.002, pnl_usd: 2.0,
    close_reason: "low yield", range_efficiency: 91.5,
  },
];
const PERF_ARCHIVE = [
  {
    pool: "PoolAddr4444444444444444444444444444444444", pool_name: "OLD-SOL",
    deployed_at: "2026-08-25T00:00:00.000Z", recorded_at: "2026-08-25T02:00:00.000Z",
    minutes_held: 120, pnl_sol: 0, fees_earned_sol: 0, pnl_usd: 0,
    close_reason: "max hold", range_efficiency: 100,
  },
];
writeJsonAtomic(statePath("lessons.json"), { lessons: [], performance: PERF, performance_archive: PERF_ARCHIVE });

// seal: W35 + Juli + Agustus (rantai bulanan nyambung)
const W35 = sealPeriod("week", "2026-W35", { now: NOW });
const JUL = sealPeriod("month", "2026-07", { now: NOW });
const AUG = sealPeriod("month", "2026-08", { now: NOW });

const parseCsv = (buffer) => {
  const text = buffer.toString("utf8");
  assert.ok(text.startsWith("\uFEFF"), "CSV harus mulai dengan BOM UTF-8");
  assert.ok(text.includes("\r\n"), "CSV harus CRLF");
  const lines = text.slice(1).split("\r\n");
  assert.equal(lines[lines.length - 1], "", "CSV harus diakhiri newline");
  return lines.slice(0, -1);
};

// ── meridian_periods.csv ─────────────────────────────────────────────

test("periods CSV: header persis §09, satu baris per seal, angka ≡ record", () => {
  const buf = toPeriodsCsv([W35, JUL, AUG], { walletId: WALLET });
  const lines = parseCsv(buf);
  assert.equal(
    lines[0],
    "period_id,kind,from_utc,to_utc,scope,wallet_id," +
      "fee_lp_sol,impermanent_loss_sol,net_revenue_sol," +
      "exec_cost_sol,exec_cost_measured_sol,gas_fee_sol,gross_rill_sol," +
      "llm_cost_sol,llm_cost_usd,net_rill_sol," +
      "saldo_awal_sol,deposit_sol,withdrawal_sol,internal_eliminated_sol,modal_dasar_sol," +
      "saldo_bebas_sol,modal_posisi_sol,modal_posisi_rent_sol,total_ekuitas_sol," +
      "laba_kumulatif_sol,unrealized_pnl_sol,unrealized_suspect," +
      "roi_dietz_pct,twr_pct," +
      "closes,win_rate_pct,sol_price_close,integrity_ok,cum_drift_sol,sealed_at",
  );
  assert.equal(lines.length, 1 + 3);

  const cols = Object.fromEntries(PERIODS_CSV_COLUMNS.map((c, i) => [c, i]));
  const aug = lines[3].split(","); // urutan input dipertahankan
  assert.equal(aug[cols.period_id], "2026-08");
  assert.equal(aug[cols.kind], "month");
  assert.equal(aug[cols.from_utc], "2026-08-01T00:00:00Z");
  assert.equal(aug[cols.to_utc], "2026-09-01T00:00:00Z");
  assert.equal(aug[cols.scope], "WALLET");
  assert.equal(aug[cols.wallet_id], WALLET);
  // angka CSV = angka record (4 desimal SOL, 2 desimal USD) — yang juga
  // dicetak formatFinancialReport, jadi CSV ≡ ringkasan teks by construction
  assert.equal(aug[cols.net_rill_sol], AUG.pnl.net_rill_sol.toFixed(4));
  assert.equal(aug[cols.gross_rill_sol], AUG.pnl.gross_rill_sol.toFixed(4));
  assert.equal(aug[cols.withdrawal_sol], "-1.0000"); // biaya bertanda −
  assert.equal(aug[cols.llm_cost_usd], AUG.pnl.llm_cost_usd.toFixed(2));
  assert.equal(aug[cols.total_ekuitas_sol], AUG.equity.total_ekuitas_sol.toFixed(4));
  assert.equal(aug[cols.internal_eliminated_sol], ""); // konsolidasi saja — kosong ≠ 0
  assert.equal(aug[cols.closes], "31");
  assert.equal(aug[cols.win_rate_pct], ((AUG.pnl.wins / 31) * 100).toFixed(2));
  assert.equal(aug[cols.sol_price_close], "200.00");
  assert.equal(aug[cols.integrity_ok], "true");
  assert.equal(aug[cols.sealed_at].endsWith("Z"), true);
});

test("periods CSV: nilai null → sel KOSONG, bukan 0", () => {
  const bare = {
    ...AUG,
    id: "2026-06", from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z",
    pnl: { ...AUG.pnl, llm_cost_sol: null, llm_cost_usd: null, closes: 0, wins: 0 },
    equity: { ...AUG.equity, unrealized_pnl_sol: null },
    roi: { dietz_pct: null, twr_pct: 0 },
    sol_price_close: null,
  };
  const cols = Object.fromEntries(PERIODS_CSV_COLUMNS.map((c, i) => [c, i]));
  const row = parseCsv(toPeriodsCsv([bare], { walletId: WALLET }))[1].split(",");
  assert.equal(row[cols.llm_cost_sol], "");
  assert.equal(row[cols.llm_cost_usd], "");
  assert.equal(row[cols.unrealized_pnl_sol], "");
  assert.equal(row[cols.roi_dietz_pct], "");
  assert.equal(row[cols.win_rate_pct], ""); // 0 closes → win rate tak terdefinisi
  assert.equal(row[cols.sol_price_close], "");
  assert.equal(row[cols.twr_pct], "0.00"); // nol sungguhan tetap 0
});

// ── meridian_closes_<period>.csv ─────────────────────────────────────

test("closes CSV: window recorded_at ≡ bookEntriesIn, escaping, kosong ≠ 0", () => {
  const all = [...PERF, ...PERF_ARCHIVE];
  const entries = closesInWindow(all, Date.parse(AUG.from), Date.parse(AUG.to));
  assert.deepEqual(entries.map((e) => e.pool_name), ["FOO-SOL", 'BAR,BAZ"X"-SOL', "OLD-SOL"]); // JUL-SOL di luar window
  const lines = parseCsv(toClosesCsv(entries, { walletId: WALLET }));
  assert.equal(lines[0], CLOSES_CSV_COLUMNS.join(","));
  assert.equal(lines.length, 1 + 3);
  // pair berkoma+kutip di-escape gaya RFC 4180
  assert.ok(lines[2].includes('"BAR,BAZ""X""-SOL"'), lines[2]);
  const foo = lines[1].split(",");
  assert.equal(foo[2], "2026-08-10T08:00:00Z"); // ISO Z, ms dinormalkan
  assert.equal(foo[3], "2026-08-10T11:58:00Z"); // closed_at, bukan recorded_at
  assert.equal(foo[5], "0.0500");
  assert.equal(foo[6], "0.0120");
  const bar = lines[2].split(",").slice(-5); // setelah sel pair yang di-quote
  assert.equal(bar[0], "-0.0200"); // pnl_sol bertanda
  assert.equal(bar[1], ""); // fees era-USD → KOSONG, bukan 0.0000
  const old = lines[3].split(",");
  assert.equal(old[6], "0.0000"); // nol sungguhan tetap ditulis 0
  assert.equal(old[3], "2026-08-25T02:00:00Z"); // tanpa closed_at → recorded_at
});

// ── meridian_curve_<period>.csv ──────────────────────────────────────

test("curve CSV: day = semua boundary, week = Senin + kedua ujung", () => {
  const snapshots = JSON.parse(fs.readFileSync(ledgerPath(WALLET, "snapshots.json"), "utf8")).snapshots;
  const augFrom = Date.parse(AUG.from);
  const augTo = Date.parse(AUG.to);

  const day = parseCsv(toCurveCsv(snapshots, { granularity: "day", from: augFrom, to: augTo, walletId: WALLET }));
  assert.equal(day[0], CURVE_CSV_COLUMNS.join(","));
  assert.equal(day.length, 1 + 32); // 1 Agu … 1 Sep inklusif kedua ujung
  assert.ok(day[1].startsWith("2026-08-01T00:00:00Z"));
  assert.ok(day[32].startsWith("2026-09-01T00:00:00Z"));

  const week = parseCsv(toCurveCsv(snapshots, { granularity: "week", from: B_START, to: B_END, walletId: WALLET }));
  // Senin: 6/29, 7/6, 7/13, 7/20, 7/27, 8/3, 8/10, 8/17, 8/24, 8/31 + ujung 9/1
  assert.equal(week.length, 1 + 11);
  assert.ok(week[1].startsWith("2026-06-29T00:00:00Z"));
  assert.ok(week[10].startsWith("2026-08-31T00:00:00Z"));
  assert.ok(week[11].startsWith("2026-09-01T00:00:00Z"));
  // titik terakhir = total ekuitas penutup — sama dengan angka laporan
  const last = week[11].split(",");
  assert.equal(last[4], AUG.equity.total_ekuitas_sol.toFixed(4));
  assert.equal(last[7], "true"); // trusted

  assert.throws(
    () => toCurveCsv(snapshots, { granularity: "hour", from: augFrom, to: augTo }),
    /tidak dikenal/,
  );
});

test("curve CSV: sol_price kosong pada entri derived (harga historis hilang)", () => {
  const derived = [{
    id: "2026-08-02", boundary_ts: "2026-08-02T00:00:00Z", source: "derived",
    equity: { saldo_bebas_sol: 5, modal_posisi_sol: 0, total_sol: 5 },
    sol_price: null, integrity: { trusted: false },
  }];
  const rows = parseCsv(toCurveCsv(derived, {
    granularity: "day", from: Date.parse("2026-08-01T00:00:00Z"), to: Date.parse("2026-08-03T00:00:00Z"), walletId: WALLET,
  }));
  const cells = rows[1].split(",");
  assert.equal(cells[5], ""); // sol_price kosong ≠ 0
  assert.equal(cells[6], "derived");
  assert.equal(cells[7], "false");
});

// ── komposisi lampiran per jenis laporan (§09) ───────────────────────

test("buildReportCsvs: mingguan → periods+closes; bulanan → +curve harian", () => {
  const wk = buildReportCsvs(W35, { wallet: WALLET });
  assert.deepEqual(wk.map((f) => f.filename), ["meridian_periods.csv", "meridian_closes_2026-W35.csv"]);
  // periods.csv dari periods.json berisi ketiga seal — dan tidak pernah YTD
  const pLines = parseCsv(wk[0].buffer);
  assert.equal(pLines.length, 1 + 3);
  assert.ok(
    pLines.slice(1).every((l) => ["week", "month", "year"].includes(l.split(",")[1])),
    "YTD tidak boleh masuk periods.csv",
  );

  const mo = buildReportCsvs(AUG, { wallet: WALLET });
  assert.deepEqual(
    mo.map((f) => f.filename),
    ["meridian_periods.csv", "meridian_closes_2026-08.csv", "meridian_curve_2026-08.csv"],
  );
  assert.equal(parseCsv(mo[1].buffer).length, 1 + 3); // 3 closes Agustus
  assert.equal(parseCsv(mo[2].buffer).length, 1 + 32); // titik harian
});

test("buildReportCsvs: YTD → periods+curve mingguan, TANPA closes; granularity dari config", () => {
  const ytd = buildYtdReport({ year: 2026, now: NOW });
  assert.equal(ytd.kind, "ytd");
  const files = buildReportCsvs(ytd, { wallet: WALLET });
  assert.deepEqual(files.map((f) => f.filename), ["meridian_periods.csv", "meridian_curve_2026-YTD.csv"]);
  // ledger mulai 29 Jun → titik: 10 Senin + ujung 1 Sep (ujung 1 Jan tak ada snapshotnya)
  assert.equal(parseCsv(files[1].buffer).length, 1 + 11);

  // knob config: bulanan bisa dipaksa mingguan
  const prevGran = config.report.curveGranularity.month;
  try {
    config.report.curveGranularity.month = "week";
    const mo = buildReportCsvs(AUG, { wallet: WALLET });
    // Agustus: ujung 8/1 + Senin 8/3, 8/10, 8/17, 8/24, 8/31 + ujung 9/1
    assert.equal(parseCsv(mo[2].buffer).length, 1 + 7);
  } finally {
    config.report.curveGranularity.month = prevGran;
  }
});

// ── zero-walk ────────────────────────────────────────────────────────

test("seluruh jalur CSV tidak pernah menyentuh network", () => {
  assert.equal(fetchCalls, 0);
});
