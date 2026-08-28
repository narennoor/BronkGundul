// Fase 7 — lampiran XLSX (financial-xlsx.js + utils/xlsx.js).
//
// Mandated by the design:
//   (a) sheet "Periode" TRANSPOSED: metrik = baris (urutan §09 persis
//       PERIODS_CSV_COLUMNS minus period_id), periode = header kolom,
//   (b) sel kosong ≠ nol — nilai null tidak menghasilkan sel sama sekali,
//   (c) angka ditulis sebagai SEL ANGKA (bukan teks) dengan gaya §09
//       (SOL 0.0000, USD/pct 0.00), bool/ISO tetap teks,
//   (d) komposisi sheet per jenis: week → Periode+Closes; month → +Kurva;
//       ytd → Periode+Kurva TANPA Closes,
//   (e) kontainer ZIP/SpreadsheetML valid — CRC cocok, semua part ada,
//   (f) seluruh jalur XLSX nol network (aturan nol-walk).
//
// Ledger sintetisnya identik dengan financial-csv.test.mjs (2026-06-29 →
// 2026-09-01, deposit 10 Jul, withdrawal 5 Agu) supaya angkanya tetap
// hand-computable dan cocok dengan angka di seal.

import { ledgerPath, statePath } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import zlib from "zlib";

process.env.RPC_URL = "http://unit-test.invalid/rpc";
process.env.HELIUS_API_KEY = "unit-test-helius-key";
process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";

const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const kp = Keypair.generate();
process.env.WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey);
const WALLET = kp.publicKey.toString();

// The entire XLSX path must never touch the network.
globalThis.fetch = async (url) => {
  throw new Error(`zero-walk violated: fetch(${String(url).slice(0, 80)})`);
};

const { sealPeriod, snapshotIdFor } = await import("../equity-snapshot.js");
const { buildYtdReport } = await import("../financial-report.js");
const { PERIODS_CSV_COLUMNS, CLOSES_CSV_COLUMNS, CURVE_CSV_COLUMNS } = await import("../financial-csv.js");
const { buildXlsx, S } = await import("../utils/xlsx.js");
const { periodsSheetRows, closesSheetRows, curveSheetRows, buildReportXlsx } = await import("../financial-xlsx.js");
const { writeJsonAtomic } = await import("../utils/json-store.js");

const DAY = 24 * 3600 * 1000;
const B_START = Date.parse("2026-06-29T00:00:00Z"); // Monday, 2026-W27
const B_END = Date.parse("2026-09-01T00:00:00Z");
const NOW = Date.parse("2026-09-02T00:30:00Z");
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// ── ledger sintetis (identik dengan financial-csv.test.mjs) ──────────
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

// bookkeeping sintetis untuk sheet Closes — FOO di window Agustus, nama pair
// dengan karakter XML nakal (&, <) untuk uji escaping, e2 era-USD tanpa
// fees_earned_sol (sel kosong ≠ 0).
const PERF = [
  {
    pool: "PoolAddr1111111111111111111111111111111111", pool_name: "FOO&BAR<SOL",
    deployed_at: "2026-08-10T08:00:00.000Z", closed_at: "2026-08-10T11:58:00.000Z",
    recorded_at: "2026-08-10T11:58:01.000Z", minutes_held: 238,
    pnl_sol: 0.05, fees_earned_sol: 0.012, pnl_usd: 10.0,
    close_reason: "trailing take profit", range_efficiency: 97.3,
  },
  {
    pool: "PoolAddr2222222222222222222222222222222222", pool_name: "USD-ONLY-SOL",
    deployed_at: "2026-08-20T01:00:00.000Z", closed_at: "2026-08-20T03:00:00.000Z",
    recorded_at: "2026-08-20T03:00:02.000Z", minutes_held: 120,
    pnl_sol: -0.02, pnl_usd: -4.0,
    close_reason: "stop loss", range_efficiency: 88,
  },
];
writeJsonAtomic(statePath("lessons.json"), { lessons: [], performance: PERF, performance_archive: [] });

const W35 = sealPeriod("week", "2026-W35", { now: NOW });
const JUL = sealPeriod("month", "2026-07", { now: NOW });
const AUG = sealPeriod("month", "2026-08", { now: NOW });

// ── pembaca ZIP mini (cukup untuk output zipSync kita: ukuran di local
//    header, tanpa data descriptor) ───────────────────────────────────
function unzip(buf) {
  const files = {};
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const csize = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const elen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nlen);
    const payload = buf.subarray(off + 30 + nlen + elen, off + 30 + nlen + elen + csize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    assert.equal(zlib.crc32(data) >>> 0, crc, `CRC ${name} harus cocok`);
    files[name] = data.toString("utf8");
    off += 30 + nlen + elen + csize;
  }
  return files;
}

// ── utils/xlsx.js ────────────────────────────────────────────────────

test("buildXlsx: kontainer ZIP valid — semua part ada, CRC cocok", () => {
  const buf = buildXlsx([{ name: "Uji", rows: [["a", 1]] }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "harus mulai dengan local file header ZIP");
  const files = unzip(buf);
  for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(files[part], `part ${part} harus ada`);
  }
  assert.ok(files["xl/workbook.xml"].includes('<sheet name="Uji" sheetId="1" r:id="rId1"/>'));
  assert.ok(files["xl/styles.xml"].includes('formatCode="0.0000"'), "gaya SOL 4 desimal harus terdaftar");
});

test("buildXlsx: angka jadi sel angka bergaya, teks di-escape, kosong dilewati", () => {
  const buf = buildXlsx([{
    name: "Sel",
    rows: [[{ v: "a&b<c", s: S.BOLD }, null, { v: -0.1234, s: S.SOL4 }, undefined, 7]],
    freeze: { x: 1, y: 1 },
  }]);
  const xml = unzip(buf)["xl/worksheets/sheet1.xml"];
  assert.ok(xml.includes(">a&amp;b&lt;c</t>"), "teks harus di-escape");
  assert.ok(xml.includes(`<c r="C1" s="${S.SOL4}"><v>-0.1234</v></c>`), "angka = sel numerik bergaya, bukan teks");
  assert.ok(xml.includes('<c r="E1" s="0"><v>7</v></c>'), "kolom sel kosong dilewati tapi referensi kolom tetap benar");
  assert.ok(!xml.includes('r="B1"') && !xml.includes('r="D1"'), "null/undefined tidak menghasilkan sel");
  assert.ok(xml.includes('<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>'));
});

test("buildXlsx: nama sheet disanitasi + dijamin unik", () => {
  const buf = buildXlsx([
    { name: "A/B:C?D", rows: [["x"]] },
    { name: "A B C D", rows: [["y"]] },
  ]);
  const wb = unzip(buf)["xl/workbook.xml"];
  assert.ok(wb.includes('name="A B C D" sheetId="1"'), "karakter terlarang jadi spasi");
  assert.ok(wb.includes('name="A B C D~2" sheetId="2"'), "nama kembar dibedakan");
});

// ── sheet Periode transposed ─────────────────────────────────────────

test("periodsSheetRows: metrik = baris, periode = header kolom, angka mentah", () => {
  const items = [W35, JUL, AUG].map((r) => ({ record: r, scope: "WALLET", walletId: WALLET }));
  const rows = periodsSheetRows(items);
  assert.deepEqual(rows[0].map((c) => c.v), ["metrik", "2026-W35", "2026-07", "2026-08"]);
  assert.equal(rows.length, 1 + PERIODS_CSV_COLUMNS.length - 1, "satu baris per kolom §09 minus period_id");
  assert.deepEqual(rows.slice(1).map((r) => r[0].v), PERIODS_CSV_COLUMNS.filter((c) => c !== "period_id"), "urutan baris = urutan §09");

  const rowOf = (m) => rows.find((r) => r[0].v === m);
  assert.deepEqual(rowOf("net_rill_sol")[3], { v: AUG.pnl.net_rill_sol, s: S.SOL4 }, "SOL = angka mentah bergaya 0.0000");
  assert.deepEqual(rowOf("withdrawal_sol")[3], { v: -1, s: S.SOL4 }, "biaya bertanda − dipertahankan");
  assert.deepEqual(rowOf("llm_cost_usd")[3], { v: AUG.pnl.llm_cost_usd, s: S.DEC2 });
  assert.deepEqual(rowOf("closes")[3], { v: 31, s: S.INT });
  assert.equal(rowOf("integrity_ok")[3], "true", "bool jadi teks");
  assert.equal(rowOf("to_utc")[3], "2026-09-01T00:00:00Z", "ISO tetap teks Z");
  assert.equal(rowOf("internal_eliminated_sol")[3], null, "null → TANPA sel, bukan 0 (kosong ≠ nol)");
  assert.equal(rowOf("kind")[1], "week");
  assert.equal(rowOf("kind")[3], "month");
});

test("periodsSheetRows: daftar campuran GROUP+wallet diberi label kolom", () => {
  const items = [
    { record: AUG, scope: "GROUP", walletId: "" },
    { record: AUG, scope: "WALLET", walletId: "CopetGundul" },
  ];
  const rows = periodsSheetRows(items);
  assert.deepEqual(rows[0].map((c) => c.v), ["metrik", "2026-08 · GROUP", "2026-08 · CopetGundul"]);
});

// ── sheet Closes / Kurva ─────────────────────────────────────────────

test("closesSheetRows: header §09, sel kosong untuk fees era-USD", () => {
  const rows = closesSheetRows(PERF, WALLET);
  assert.deepEqual(rows[0].map((c) => c.v), CLOSES_CSV_COLUMNS);
  const fees = CLOSES_CSV_COLUMNS.indexOf("fees_sol");
  assert.deepEqual(rows[1][fees], { v: 0.012, s: S.SOL4 });
  assert.equal(rows[2][fees], null, "era-USD tanpa fees_earned_sol → tanpa sel");
});

test("curveSheetRows: granularitas week = Senin + kedua ujung", () => {
  const snaps = JSON.parse(fs.readFileSync(ledgerPath(WALLET, "snapshots.json"), "utf8")).snapshots;
  const from = Date.parse(AUG.from);
  const to = Date.parse(AUG.to);
  const rows = curveSheetRows([{ walletId: WALLET, snapshots: snaps }], { granularity: "week", from, to });
  assert.deepEqual(rows[0].map((c) => c.v), CURVE_CSV_COLUMNS);
  const ts = rows.slice(1).map((r) => r[0]);
  assert.equal(ts[0], "2026-08-01T00:00:00Z", "ujung awal periode selalu ikut");
  assert.equal(ts[ts.length - 1], "2026-09-01T00:00:00Z", "ujung akhir periode selalu ikut");
  for (const t of ts.slice(1, -1)) {
    assert.equal(new Date(t).getUTCDay(), 1, `${t} harus Senin`);
  }
});

// ── komposisi workbook per jenis laporan ─────────────────────────────

test("buildReportXlsx month: satu file, sheet Periode+Closes+Kurva", () => {
  const files = buildReportXlsx(AUG, { wallet: WALLET });
  assert.equal(files.length, 1, "satu lampiran, bukan tiga");
  assert.equal(files[0].filename, "meridian_report_2026-08.xlsx");
  const parts = unzip(files[0].buffer);
  const wb = parts["xl/workbook.xml"];
  assert.ok(wb.includes('name="Periode"') && wb.includes('name="Closes"') && wb.includes('name="Kurva"'));
  assert.ok(parts["xl/worksheets/sheet1.xml"].includes(">2026-08</t>"), "header kolom periode di sheet Periode");
  assert.ok(parts["xl/worksheets/sheet2.xml"].includes(">FOO&amp;BAR&lt;SOL</t>"), "nama pair di-escape di sheet Closes");
  assert.ok(files[0].caption.includes("Closes (2)"));
});

test("buildReportXlsx ytd: Periode+Kurva TANPA Closes", () => {
  const ytd = buildYtdReport({ year: 2026, now: NOW });
  const files = buildReportXlsx(ytd, { wallet: WALLET });
  assert.equal(files[0].filename, "meridian_report_2026-YTD.xlsx");
  const wb = unzip(files[0].buffer)["xl/workbook.xml"];
  assert.ok(wb.includes('name="Periode"') && wb.includes('name="Kurva"'));
  assert.ok(!wb.includes('name="Closes"'), "YTD tidak membawa Closes — window-nya masih tumbuh");
});

test("buildReportXlsx week: Periode+Closes tanpa Kurva (7 titik bukan kurva)", () => {
  const files = buildReportXlsx(W35, { wallet: WALLET });
  const wb = unzip(files[0].buffer)["xl/workbook.xml"];
  assert.ok(wb.includes('name="Periode"') && wb.includes('name="Closes"'));
  assert.ok(!wb.includes('name="Kurva"'));
});
