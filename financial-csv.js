// financial-csv.js — data lampiran laporan keuangan (§09, fase 4).
//
// Sejak fase 7 modul ini adalah SUMBER DATA lampiran, bukan lagi format
// kirimnya: jalur Telegram melampirkan satu workbook XLSX (financial-xlsx.js)
// yang dibangun dari nilai sel bertipe di sini. Serializer CSV dipertahankan
// utuh — dialah rujukan §09 (urutan+nama kolom, kosong ≠ nol) dan tetap
// dipakai unit test sebagai spesifikasi yang bisa di-diff.
//
// Tiga tabel: periods (berkelanjutan, satu untuk SEMUA jenis, kolom `kind`
// yang membedakan — dibangun ulang utuh dari periods.json setiap kirim, bukan
// di-append, jadi idempoten dan tidak pernah menyimpang dari sumbernya),
// closes_<period_id> (detail per posisi tertutup dari bookkeeping lessons.json
// — filter recorded_at yang sama dengan bookEntriesIn, jadi jumlah barisnya
// SELALU sama dengan pnl.closes di seal), dan curve_<period_id> (titik kurva
// ekuitas dari snapshot harian — granularitas day|week menyesuaikan jenis
// laporan, ongkos nol karena snapshotnya sudah ada).
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
  ledgerWalletAddress,
} from "./equity-snapshot.js";
import { loadRegistry, walletsActiveIn } from "./ledger-registry.js";
import { readLedger } from "./ledger-transport.js";
import { consolidatePeriod } from "./consolidate.js";

const BOM = "\uFEFF";
const EOL = "\r\n"; // Excel Windows

// ─── formatter sel CSV ───────────────────────────────────────────────
// null/undefined → sel kosong (tidak berlaku ≠ nol). Angka SELALU polos
// (tanpa "+" eksplisit) supaya Excel membacanya sebagai angka, bukan teks;
// tanda ikut konvensi record (pendapatan +, biaya −). (-0).toFixed() memberi
// "0.0000" tanpa tanda, jadi nol tidak pernah tampil sebagai "-0".
const sol4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : "");
const usd2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "");
const pct2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "");
const intc = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "");
const boolc = (v) => (v == null ? "" : v ? "true" : "false");
// Timestamp dinormalkan SEKALI di nilai bertipe (isoRaw) — formatter CSV-nya
// tinggal identitas-atau-kosong.
const isoRaw = (v) => {
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : null;
};

function cell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvBuffer(header, rows) {
  const lines = [header, ...rows].map((r) => r.map(cell).join(","));
  return Buffer.from(BOM + lines.join(EOL) + EOL, "utf8");
}

// ─── nilai sel bertipe (dipakai CSV di sini + XLSX di financial-xlsx.js) ──
// Nilai MENTAH (number/bool/string/null), bukan string terformat: penyaji
// XLSX butuh angka sungguhan supaya Excel bisa memformat/menjumlahkannya.
// Tipe per kolom memberi tahu penyaji cara menampilkan: sol → 0.0000,
// usd/pct → 0.00, int → bulat, bool → true/false/kosong, iso/text → teks.

const CSV_FMT = {
  sol: sol4,
  usd: usd2,
  pct: pct2,
  int: intc,
  bool: boolc,
  iso: (v) => v ?? "",
  text: (v) => v ?? "",
};

const rowFromValues = (columns, types, vals) => columns.map((c) => CSV_FMT[types[c]](vals[c]));

// ─── meridian_periods ────────────────────────────────────────────────

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

export const PERIOD_CELL_TYPES = {
  period_id: "text", kind: "text", from_utc: "iso", to_utc: "iso", scope: "text", wallet_id: "text",
  fee_lp_sol: "sol", impermanent_loss_sol: "sol", net_revenue_sol: "sol",
  exec_cost_sol: "sol", exec_cost_measured_sol: "sol", gas_fee_sol: "sol", gross_rill_sol: "sol",
  llm_cost_sol: "sol", llm_cost_usd: "usd", net_rill_sol: "sol",
  saldo_awal_sol: "sol", deposit_sol: "sol", withdrawal_sol: "sol", internal_eliminated_sol: "sol", modal_dasar_sol: "sol",
  saldo_bebas_sol: "sol", modal_posisi_sol: "sol", modal_posisi_rent_sol: "sol", total_ekuitas_sol: "sol",
  laba_kumulatif_sol: "sol", unrealized_pnl_sol: "sol", unrealized_suspect: "bool",
  roi_dietz_pct: "pct", twr_pct: "pct",
  closes: "int", win_rate_pct: "pct", sol_price_close: "usd", integrity_ok: "bool", cum_drift_sol: "sol", sealed_at: "iso",
};

/**
 * Nilai §09 dari satu record periode (seal wallet ATAU record grup dari
 * consolidatePeriod — bentuknya sama; record grup punya internal_eliminated_sol
 * terisi dan sealed_at kosong karena record grup tidak pernah disegel).
 */
export function periodCellValues(r, scope, walletId) {
  const winRate = r.pnl.closes > 0 ? (r.pnl.wins / r.pnl.closes) * 100 : null;
  return {
    period_id: r.id, kind: r.kind, from_utc: isoRaw(r.from), to_utc: isoRaw(r.to), scope, wallet_id: walletId,
    fee_lp_sol: r.pnl.fee_lp_sol, impermanent_loss_sol: r.pnl.impermanent_loss_sol, net_revenue_sol: r.pnl.net_revenue_sol,
    exec_cost_sol: r.pnl.exec_cost_sol, exec_cost_measured_sol: r.pnl.exec_cost_measured_sol,
    gas_fee_sol: r.pnl.gas_fee_sol, gross_rill_sol: r.pnl.gross_rill_sol,
    llm_cost_sol: r.pnl.llm_cost_sol, llm_cost_usd: r.pnl.llm_cost_usd, net_rill_sol: r.pnl.net_rill_sol,
    saldo_awal_sol: r.equity.saldo_awal_sol, deposit_sol: r.equity.deposit_sol, withdrawal_sol: r.equity.withdrawal_sol,
    internal_eliminated_sol: r.equity.internal_eliminated_sol, modal_dasar_sol: r.equity.modal_dasar_sol,
    saldo_bebas_sol: r.equity.saldo_bebas_sol, modal_posisi_sol: r.equity.modal_posisi_sol,
    modal_posisi_rent_sol: r.equity.modal_posisi_rent_sol, total_ekuitas_sol: r.equity.total_ekuitas_sol,
    laba_kumulatif_sol: r.equity.laba_kumulatif_sol, unrealized_pnl_sol: r.equity.unrealized_pnl_sol,
    unrealized_suspect: r.equity.unrealized_suspect,
    roi_dietz_pct: r.roi.dietz_pct, twr_pct: r.roi.twr_pct,
    closes: r.pnl.closes, win_rate_pct: winRate, sol_price_close: r.sol_price_close,
    integrity_ok: r.integrity.integrity_ok, cum_drift_sol: r.integrity.cum_drift_sol, sealed_at: isoRaw(r.sealed_at),
  };
}

const periodCsvRow = (r, scope, walletId) =>
  rowFromValues(PERIODS_CSV_COLUMNS, PERIOD_CELL_TYPES, periodCellValues(r, scope, walletId));

/**
 * Satu baris per periode TERSEGEL (week/month/year — YTD tidak pernah masuk,
 * dia belum disegel). `scope` membuat baris grup dan per-wallet hidup di satu
 * berkas: fase 4 hanya menulis WALLET; konsolidasi fase 5 menambah baris GROUP
 * lebih dulu untuk period_id yang sama (toGroupPeriodsCsv).
 * internal_eliminated_sol hanya bermakna di level grup → kosong pada baris
 * WALLET.
 */
export function toPeriodsCsv(periods, { walletId, scope = "WALLET" } = {}) {
  return toCsvBuffer(PERIODS_CSV_COLUMNS, periods.map((r) => periodCsvRow(r, scope, walletId)));
}

/**
 * Versi grup dari berkas yang SAMA (§09): items = [{ record, scope, walletId }]
 * sudah terurut oleh pemanggil — baris GROUP lebih dulu, lalu WALLET per
 * wallet untuk period_id yang sama. wallet_id kosong pada baris GROUP (tidak
 * berlaku ≠ nol).
 */
export function toGroupPeriodsCsv(items) {
  return toCsvBuffer(PERIODS_CSV_COLUMNS, items.map(({ record, scope, walletId }) => periodCsvRow(record, scope, walletId ?? "")));
}

// ─── meridian_closes_<period_id> ─────────────────────────────────────

export const CLOSES_CSV_COLUMNS = [
  "pool", "pair", "deployed_at", "closed_at", "minutes_held",
  "pnl_sol", "fees_sol", "close_reason", "range_efficiency", "wallet_id",
];

export const CLOSE_CELL_TYPES = {
  pool: "text", pair: "text", deployed_at: "iso", closed_at: "iso", minutes_held: "int",
  pnl_sol: "sol", fees_sol: "sol", close_reason: "text", range_efficiency: "pct", wallet_id: "text",
};

/**
 * Detail per posisi tertutup, dari entri performance (lessons.json — sumber
 * yang sama dengan book.closed di snapshot harian). pnl_sol/fees_sol native
 * SOL bila tercatat (fees_earned_sol ada sejak 3 Agu 2026); entri lama yang
 * cuma punya USD dapat sel KOSONG, bukan konversi diam-diam — konversi harga
 * campuran sudah dilakukan sekali di jalur fee_lp_sol snapshot dan tidak
 * boleh terjadi dua kali dengan harga berbeda.
 */
export function closeCellValues(e, walletId) {
  return {
    pool: e.pool ?? "", pair: e.pool_name ?? "",
    deployed_at: isoRaw(e.deployed_at), closed_at: isoRaw(e.closed_at ?? e.recorded_at),
    minutes_held: e.minutes_held, pnl_sol: e.pnl_sol, fees_sol: e.fees_earned_sol,
    close_reason: e.close_reason ?? "", range_efficiency: e.range_efficiency, wallet_id: walletId,
  };
}

export function toClosesCsv(entries, { walletId } = {}) {
  return toCsvBuffer(
    CLOSES_CSV_COLUMNS,
    entries.map((e) => rowFromValues(CLOSES_CSV_COLUMNS, CLOSE_CELL_TYPES, closeCellValues(e, walletId))),
  );
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

// ─── meridian_curve_<period_id> ──────────────────────────────────────

export const CURVE_CSV_COLUMNS = [
  "ts_utc", "wallet_id", "saldo_bebas_sol", "modal_posisi_sol", "total_ekuitas_sol",
  "sol_price", "source", "trusted",
];

export const CURVE_CELL_TYPES = {
  ts_utc: "iso", wallet_id: "text", saldo_bebas_sol: "sol", modal_posisi_sol: "sol",
  total_ekuitas_sol: "sol", sol_price: "usd", source: "text", trusted: "bool",
};

export function curveCellValues(s, walletId) {
  return {
    ts_utc: isoRaw(s.boundary_ts), wallet_id: walletId,
    saldo_bebas_sol: s.equity.saldo_bebas_sol, modal_posisi_sol: s.equity.modal_posisi_sol,
    total_ekuitas_sol: s.equity.total_sol,
    sol_price: s.sol_price, source: s.source ?? "", trusted: s.integrity?.trusted,
  };
}

/**
 * Pemilih titik kurva dari snapshot harian yang sudah ada (ongkos nol).
 * granularity "day" = semua boundary di [from, to]; "week" = boundary Senin
 * 00:00Z saja, plus KEDUA ujung periode supaya kurvanya selalu mulai dan
 * berakhir di angka laporan (52-an baris untuk setahun, bukan 365). sol_price
 * kosong pada entri derived — harga historis tidak bisa dipulihkan, dan kosong
 * ≠ nol.
 */
export function curveSnapshotsIn(snapshots, { granularity, from, to }) {
  if (granularity !== "day" && granularity !== "week") {
    throw new Error(`granularity "${granularity}" tidak dikenal — day | week`);
  }
  return snapshots.filter((s) => {
    const b = Date.parse(s.boundary_ts);
    if (b < from || b > to) return false;
    if (granularity === "day") return true;
    return new Date(b).getUTCDay() === 1 || b === from || b === to;
  });
}

function curveRows(snapshots, { granularity, from, to, walletId }) {
  return curveSnapshotsIn(snapshots, { granularity, from, to }).map((s) =>
    rowFromValues(CURVE_CSV_COLUMNS, CURVE_CELL_TYPES, curveCellValues(s, walletId)),
  );
}

export function toCurveCsv(snapshots, { granularity, from, to, walletId } = {}) {
  return toCsvBuffer(CURVE_CSV_COLUMNS, curveRows(snapshots, { granularity, from, to, walletId }));
}

/**
 * Kurva grup: baris per WALLET per titik (§09 — "52-an baris per wallet"),
 * tanpa baris agregat sintetis: menjumlahkan tanggal yang snapshotnya bolong
 * di salah satu wallet akan menggambar dip palsu; pivot-sum di Excel bila
 * perlu total. series = [{ walletId, snapshots }].
 */
export function toGroupCurveCsv(series, { granularity, from, to } = {}) {
  const rows = series.flatMap(({ walletId, snapshots }) =>
    curveRows(snapshots, { granularity, from, to, walletId }),
  );
  return toCsvBuffer(CURVE_CSV_COLUMNS, rows);
}

// ─── item periode GRUP (dipakai CSV grup + XLSX grup) ────────────────

/**
 * Union (kind, id) dari seal semua wallet registry, terurut (from, kind)
 * seperti loadPeriods, sebagai [{ record, scope, walletId }]: baris GROUP
 * lebih dulu (dihitung ulang lewat consolidatePeriod — deterministik, nol
 * network, record grup memang tidak pernah disegel) lalu WALLET per wallet.
 * Konsolidasi satu periode yang gagal (mis. ledger salah satu wallet belum
 * ada saat itu) melewati baris GROUP-nya saja; baris WALLET tetap ditulis.
 * ledgers = registry.wallets.map((w) => ({ w, ...readLedger(w) })).
 */
export function collectGroupPeriodItems(registry, ledgers) {
  const byKey = new Map();
  for (const { w, periods } of ledgers) {
    for (const p of periods) {
      const key = `${p.kind}:${p.id}`;
      if (!byKey.has(key)) byKey.set(key, { kind: p.kind, id: p.id, from: p.from, seals: [] });
      byKey.get(key).seals.push({ walletId: w.id, record: p });
    }
  }
  const keys = [...byKey.values()].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.kind.localeCompare(b.kind),
  );
  const items = [];
  for (const k of keys) {
    try {
      items.push({ record: consolidatePeriod({ kind: k.kind, id: k.id, registry }), scope: "GROUP", walletId: "" });
    } catch {
      // baris GROUP dilewati — baris WALLET di bawah tetap menceritakan datanya
    }
    for (const { w } of ledgers) {
      const seal = k.seals.find((s) => s.walletId === w.id);
      if (seal) items.push({ record: seal.record, scope: "WALLET", walletId: w.id });
    }
  }
  return items;
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
 * (csvEnabled) dan menelan error kirim. CATATAN fase 7: jalur Telegram kini
 * mengirim workbook XLSX (financial-xlsx.js); perakit CSV ini tinggal sebagai
 * spesifikasi §09 + jalur ekspor manual.
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

/**
 * Lampiran §09 versi GRUP (fase 5) — bentuk CSV-nya; jalur Telegram memakai
 * padanan XLSX di financial-xlsx.js:
 *
 *   meridian_periods.csv        baris GROUP lebih dulu lalu WALLET per wallet,
 *                               untuk UNION semua (kind, id) tersegel di
 *                               registry (collectGroupPeriodItems)
 *   meridian_closes_<id>.csv    tetap posisi wallet SENDIRI — detail close
 *                               hidup di lessons.json per daemon dan tidak
 *                               diangkut transport ledger (hanya snapshots +
 *                               periods), jadi baris wallet lain tidak bisa
 *                               jujur dibuat di sini
 *   meridian_curve_<id>.csv     baris per wallet dari ledger masing-masing
 *
 * Murni berkas lokal — nol Helius, nol RPC.
 */
export function buildGroupReportCsvs(groupRecord) {
  const registry = loadRegistry();
  const ledgers = registry.wallets.map((w) => ({ w, ...readLedger(w) }));
  const items = collectGroupPeriodItems(registry, ledgers);
  const files = [
    {
      filename: "meridian_periods.csv",
      buffer: toGroupPeriodsCsv(items),
      caption: `Semua periode tersegel — ${items.length} baris GROUP+WALLET (filter kolom scope/kind di Excel)`,
    },
  ];

  const from = Date.parse(groupRecord.from);
  const to = Date.parse(groupRecord.to);

  if (groupRecord.kind !== "ytd") {
    const own = ledgerWalletAddress();
    const ownId = registry.wallets.find((w) => w.address === own)?.id ?? own;
    const entries = closesInWindow(readPerformanceEntries(), from, to);
    files.push({
      filename: `meridian_closes_${groupRecord.id}.csv`,
      buffer: toClosesCsv(entries, { walletId: ownId }),
      caption: `Detail ${entries.length} posisi tertutup (wallet ${ownId}) · ${groupRecord.id}`,
    });
  }

  const gran = config.report.curveGranularity ?? {};
  const granularity =
    groupRecord.kind === "month" ? (gran.month ?? "day")
    : groupRecord.kind === "year" ? (gran.year ?? "week")
    : groupRecord.kind === "ytd" ? (gran.ytd ?? "week")
    : null;
  if (granularity) {
    const series = walletsActiveIn(from, to, registry).map((w) => ({
      walletId: w.id,
      snapshots: ledgers.find((l) => l.w.id === w.id)?.snapshots ?? [],
    }));
    files.push({
      filename: `meridian_curve_${groupRecord.id}.csv`,
      buffer: toGroupCurveCsv(series, { granularity, from, to }),
      caption: `Kurva ekuitas ${granularity === "day" ? "harian" : "mingguan"} per wallet · ${groupRecord.id}`,
    });
  }
  return files;
}
