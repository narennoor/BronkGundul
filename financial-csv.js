// financial-csv.js — lampiran CSV laporan keuangan (§09, fase 4).
//
// Tiga berkas: meridian_periods.csv (berkelanjutan, satu untuk SEMUA jenis,
// kolom `kind` yang membedakan — dibangun ulang utuh dari periods.json setiap
// kirim, bukan di-append, jadi idempoten dan tidak pernah menyimpang dari
// sumbernya), meridian_closes_<period_id>.csv (detail per posisi tertutup dari
// bookkeeping lessons.json — filter recorded_at yang sama dengan bookEntriesIn,
// jadi jumlah barisnya SELALU sama dengan pnl.closes di seal), dan
// meridian_curve_<period_id>.csv (titik kurva ekuitas dari snapshot harian —
// granularitas day|week menyesuaikan jenis laporan, ongkos nol karena
// snapshotnya sudah ada).
//
// Konvensi format (§09): UTF-8 DENGAN BOM (tanpa itu Excel di Windows mengacak
// karakter non-ASCII di nama pool), CRLF, pemisah koma, desimal titik, SOL 4
// desimal bertanda, USD 2 desimal, timestamp ISO-8601 UTC bersufiks Z. Sel
// kosong berarti tidak berlaku; nol ditulis 0 — keduanya beda arti dan tidak
// boleh disamakan (fees_sol era lama yang cuma tercatat USD → kosong, bukan 0).
//
// HARD RULE: modul ini tidak boleh meng-import pnl-report.js (aturan nol-walk)
// — semuanya aritmetika atas berkas ledger + lessons.json, nol Helius, nol RPC.

import { config } from "./config.js";
import {
  loadPeriods,
  loadSnapshots,
  readPerformanceEntries,
} from "./equity-snapshot.js";

const BOM = "\uFEFF";
const EOL = "\r\n"; // Excel Windows

// ─── formatter sel ───────────────────────────────────────────────────
// null/undefined → sel kosong (tidak berlaku ≠ nol). Angka SELALU polos
// (tanpa "+" eksplisit) supaya Excel membacanya sebagai angka, bukan teks;
// tanda ikut konvensi record (pendapatan +, biaya −). (-0).toFixed() memberi
// "0.0000" tanpa tanda, jadi nol tidak pernah tampil sebagai "-0".
const sol4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : "");
const usd2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "");
const pct2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "");
const intc = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "");
const boolc = (v) => (v == null ? "" : v ? "true" : "false");
const isoc = (v) => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : "";
};

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvBuffer(header, rows) {
  const lines = [header, ...rows].map((r) => r.map(cell).join(","));
  return Buffer.from(BOM + lines.join(EOL) + EOL, "utf8");
}

// ─── meridian_periods.csv ────────────────────────────────────────────

// Urutan dan nama kolom PERSIS §09 — jangan diubah: berkas ini kumulatif dan
// yang lama harus tetap bisa di-diff/di-pivot terhadap yang baru.
export const PERIODS_CSV_COLUMNS = [
  "period_id", "kind", "from_utc", "to_utc", "scope", "wallet_id",
  "fee_lp_sol", "impermanent_loss_sol", "net_revenue_sol",
  "exec_cost_sol", "exec_cost_measured_sol", "gas_fee_sol", "gross_rill_sol",
  "llm_cost_sol", "llm_cost_usd", "net_rill_sol",
  "saldo_awal_sol", "deposit_sol", "withdrawal_sol", "internal_eliminated_sol", "modal_dasar_sol",
  "saldo_bebas_sol", "modal_posisi_sol", "modal_posisi_rent_sol", "total_ekuitas_sol",
  "laba_kumulatif_sol", "unrealized_pnl_sol", "unrealized_suspect",
  "roi_dietz_pct", "twr_pct",
  "closes", "win_rate_pct", "sol_price_close", "integrity_ok", "cum_drift_sol", "sealed_at",
];

/**
 * Satu baris per periode TERSEGEL (week/month/year — YTD tidak pernah masuk,
 * dia belum disegel). `scope` membuat baris grup dan per-wallet hidup di satu
 * berkas: fase 4 hanya menulis WALLET; konsolidasi fase 5 menambah baris GROUP
 * lebih dulu untuk period_id yang sama. internal_eliminated_sol hanya bermakna
 * di level grup → kosong pada baris WALLET.
 */
export function toPeriodsCsv(periods, { walletId, scope = "WALLET" } = {}) {
  const rows = periods.map((r) => {
    const winRate = r.pnl.closes > 0 ? (r.pnl.wins / r.pnl.closes) * 100 : null;
    return [
      r.id, r.kind, isoc(r.from), isoc(r.to), scope, walletId,
      sol4(r.pnl.fee_lp_sol), sol4(r.pnl.impermanent_loss_sol), sol4(r.pnl.net_revenue_sol),
      sol4(r.pnl.exec_cost_sol), sol4(r.pnl.exec_cost_measured_sol), sol4(r.pnl.gas_fee_sol), sol4(r.pnl.gross_rill_sol),
      sol4(r.pnl.llm_cost_sol), usd2(r.pnl.llm_cost_usd), sol4(r.pnl.net_rill_sol),
      sol4(r.equity.saldo_awal_sol), sol4(r.equity.deposit_sol), sol4(r.equity.withdrawal_sol),
      sol4(r.equity.internal_eliminated_sol), sol4(r.equity.modal_dasar_sol),
      sol4(r.equity.saldo_bebas_sol), sol4(r.equity.modal_posisi_sol), sol4(r.equity.modal_posisi_rent_sol),
      sol4(r.equity.total_ekuitas_sol),
      sol4(r.equity.laba_kumulatif_sol), sol4(r.equity.unrealized_pnl_sol), boolc(r.equity.unrealized_suspect),
      pct2(r.roi.dietz_pct), pct2(r.roi.twr_pct),
      intc(r.pnl.closes), pct2(winRate), usd2(r.sol_price_close),
      boolc(r.integrity.integrity_ok), sol4(r.integrity.cum_drift_sol), isoc(r.sealed_at),
    ];
  });
  return toCsvBuffer(PERIODS_CSV_COLUMNS, rows);
}

// ─── meridian_closes_<period_id>.csv ─────────────────────────────────

export const CLOSES_CSV_COLUMNS = [
  "pool", "pair", "deployed_at", "closed_at", "minutes_held",
  "pnl_sol", "fees_sol", "close_reason", "range_efficiency", "wallet_id",
];

/**
 * Detail per posisi tertutup, dari entri performance (lessons.json — sumber
 * yang sama dengan book.closed di snapshot harian). pnl_sol/fees_sol native
 * SOL bila tercatat (fees_earned_sol ada sejak 3 Agu 2026); entri lama yang
 * cuma punya USD dapat sel KOSONG, bukan konversi diam-diam — konversi harga
 * campuran sudah dilakukan sekali di jalur fee_lp_sol snapshot dan tidak
 * boleh terjadi dua kali dengan harga berbeda.
 */
export function toClosesCsv(entries, { walletId } = {}) {
  const rows = entries.map((e) => [
    e.pool ?? "", e.pool_name ?? "", isoc(e.deployed_at), isoc(e.closed_at ?? e.recorded_at),
    intc(e.minutes_held),
    sol4(e.pnl_sol), sol4(e.fees_earned_sol),
    e.close_reason ?? "", pct2(e.range_efficiency), walletId,
  ]);
  return toCsvBuffer(CLOSES_CSV_COLUMNS, rows);
}

/** Entri performance yang jatuh di [from, to) — kriteria recorded_at yang
 *  sama persis dengan bookEntriesIn, supaya barisnya cocok dengan pnl.closes. */
export function closesInWindow(entries, fromMs, toMs) {
  return entries
    .filter((e) => {
      const at = Date.parse(e.recorded_at);
      return Number.isFinite(at) && at >= fromMs && at < toMs;
    })
    .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
}

// ─── meridian_curve_<period_id>.csv ──────────────────────────────────

export const CURVE_CSV_COLUMNS = [
  "ts_utc", "wallet_id", "saldo_bebas_sol", "modal_posisi_sol", "total_ekuitas_sol",
  "sol_price", "source", "trusted",
];

/**
 * Titik kurva ekuitas dari snapshot harian yang sudah ada (ongkos nol).
 * granularity "day" = semua boundary di [from, to]; "week" = boundary Senin
 * 00:00Z saja, plus KEDUA ujung periode supaya kurvanya selalu mulai dan
 * berakhir di angka laporan (52-an baris untuk setahun, bukan 365). sol_price
 * kosong pada entri derived — harga historis tidak bisa dipulihkan, dan kosong
 * ≠ nol.
 */
export function toCurveCsv(snapshots, { granularity, from, to, walletId } = {}) {
  if (granularity !== "day" && granularity !== "week") {
    throw new Error(`granularity "${granularity}" tidak dikenal — day | week`);
  }
  const points = snapshots.filter((s) => {
    const b = Date.parse(s.boundary_ts);
    if (b < from || b > to) return false;
    if (granularity === "day") return true;
    return new Date(b).getUTCDay() === 1 || b === from || b === to;
  });
  const rows = points.map((s) => [
    isoc(s.boundary_ts), walletId,
    sol4(s.equity.saldo_bebas_sol), sol4(s.equity.modal_posisi_sol), sol4(s.equity.total_sol),
    usd2(s.sol_price), s.source ?? "", boolc(s.integrity?.trusted),
  ]);
  return toCsvBuffer(CURVE_CSV_COLUMNS, rows);
}

// ─── perakit lampiran per jenis laporan ──────────────────────────────

/**
 * Lampiran §09 untuk satu record laporan (seal week/month/year, atau record
 * YTD dari buildYtdReport):
 *
 *   mingguan → periods + closes            (7 titik bukan kurva)
 *   bulanan  → periods + closes + curve    (titik harian)
 *   tahunan  → periods + closes + curve    (titik mingguan)
 *   YTD      → periods + curve             (titik mingguan; belum ada closes
 *                                           tersegel — window-nya masih tumbuh)
 *
 * Murni berkas lokal — nol Helius, nol RPC. Return [{filename, buffer,
 * caption}] siap untuk sendDocument; pemanggil yang memutuskan kirim/tidak
 * (csvEnabled) dan menelan error kirim.
 */
export function buildReportCsvs(record, { wallet }) {
  const files = [];
  const periods = loadPeriods(wallet).periods;
  files.push({
    filename: "meridian_periods.csv",
    buffer: toPeriodsCsv(periods, { walletId: wallet }),
    caption: `Semua periode tersegel — ${periods.length} baris (filter kolom kind di Excel)`,
  });

  const from = Date.parse(record.from);
  const to = Date.parse(record.to);

  if (record.kind !== "ytd") {
    const entries = closesInWindow(readPerformanceEntries(), from, to);
    files.push({
      filename: `meridian_closes_${record.id}.csv`,
      buffer: toClosesCsv(entries, { walletId: wallet }),
      caption: `Detail ${entries.length} posisi tertutup · ${record.id}`,
    });
  }

  const gran = config.report.curveGranularity ?? {};
  const granularity =
    record.kind === "month" ? (gran.month ?? "day")
    : record.kind === "year" ? (gran.year ?? "week")
    : record.kind === "ytd" ? (gran.ytd ?? "week")
    : null; // mingguan: tujuh titik tidak membentuk kurva (§09)
  if (granularity) {
    const snapshots = loadSnapshots(wallet).snapshots;
    files.push({
      filename: `meridian_curve_${record.id}.csv`,
      buffer: toCurveCsv(snapshots, { granularity, from, to, walletId: wallet }),
      caption: `Kurva ekuitas ${granularity === "day" ? "harian" : "mingguan"} · ${record.id}`,
    });
  }
  return files;
}
