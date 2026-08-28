// financial-xlsx.js — lampiran laporan keuangan sebagai SATU workbook XLSX
// (fase 7). Menggantikan 2–3 berkas CSV di jalur Telegram dengan satu dokumen
// yang sudah terformat: angka sungguhan (bukan teks), header bold, panel beku.
//
// Sheet "Periode" sengaja TRANSPOSED — metrik jadi BARIS (urutan §09 persis
// PERIODS_CSV_COLUMNS), periode (2026-W31, 2026-08, …) jadi HEADER KOLOM —
// meniru tata letak vertikal laporan HTML §06 sehingga laporan teks dan
// lampirannya terbaca searah. "Closes" dan "Kurva" tetap tabel baris: deret
// per posisi / per tanggal memang deret, bukan kartu metrik.
//
// Semua ISI sel datang dari nilai bertipe di financial-csv.js
// (periodCellValues dkk.) — §09 punya satu sumber kebenaran; modul ini murni
// penyaji. HARD RULE yang sama: tidak boleh meng-import pnl-report.js —
// murni berkas ledger + lessons.json, nol Helius, nol RPC.

import { config } from "./config.js";
import {
  loadPeriods,
  loadSnapshots,
  readPerformanceEntries,
  ledgerWalletAddress,
} from "./equity-snapshot.js";
import { loadRegistry, walletsActiveIn } from "./ledger-registry.js";
import { readLedger } from "./ledger-transport.js";
import {
  PERIODS_CSV_COLUMNS, PERIOD_CELL_TYPES, periodCellValues,
  CLOSES_CSV_COLUMNS, CLOSE_CELL_TYPES, closeCellValues,
  CURVE_CSV_COLUMNS, CURVE_CELL_TYPES, curveCellValues,
  closesInWindow, curveSnapshotsIn, collectGroupPeriodItems,
} from "./financial-csv.js";
import { buildXlsx, S } from "./utils/xlsx.js";

// Tipe §09 → gaya sel XLSX. bool/iso jadi teks (true/false / ISO-8601 Z) —
// serial tanggal Excel menyeret zona waktu, ISO teks tidak ambigu.
const STYLE_OF = { sol: S.SOL4, usd: S.DEC2, pct: S.DEC2, int: S.INT, bool: S.TEXT, iso: S.TEXT, text: S.TEXT };

function typedCell(type, v) {
  if (v == null || v === "") return null; // sel kosong ≠ nol (§09)
  if (type === "bool") return v ? "true" : "false";
  if (type === "sol" || type === "usd" || type === "pct" || type === "int") {
    return Number.isFinite(v) ? { v, s: STYLE_OF[type] } : null;
  }
  return String(v);
}

const bold = (v) => ({ v, s: S.BOLD });

// ─── sheet "Periode" (transposed) ────────────────────────────────────

/**
 * items = [{ record, scope, walletId }] — bentuk yang sama dengan
 * toGroupPeriodsCsv. Kolom pertama = nama metrik §09; tiap item jadi satu
 * kolom berjudul period_id-nya (plus label GROUP/wallet bila daftarnya
 * campuran, supaya "2026-W35 · GROUP" dan "2026-W35 · CopetGundul" bisa
 * berdampingan). Di-export untuk unit test.
 */
export function periodsSheetRows(items) {
  const mixed = new Set(items.map((i) => `${i.scope}|${i.walletId ?? ""}`)).size > 1;
  const header = [
    bold("metrik"),
    ...items.map(({ record, scope, walletId }) =>
      bold(mixed ? `${record.id} · ${scope === "GROUP" ? "GROUP" : walletId}` : record.id),
    ),
  ];
  const values = items.map(({ record, scope, walletId }) => periodCellValues(record, scope, walletId ?? ""));
  const rows = [header];
  for (const col of PERIODS_CSV_COLUMNS) {
    if (col === "period_id") continue; // sudah jadi header kolom
    rows.push([bold(col), ...values.map((v) => typedCell(PERIOD_CELL_TYPES[col], v[col]))]);
  }
  return rows;
}

const periodsSheet = (items) => ({
  name: "Periode",
  rows: periodsSheetRows(items),
  colWidths: [24],
  defaultColWidth: 16,
  freeze: { x: 1, y: 1 }, // label metrik + header periode selalu terlihat
});

// ─── sheet "Closes" / "Kurva" (tabel baris) ──────────────────────────

export function closesSheetRows(entries, walletId) {
  return [
    CLOSES_CSV_COLUMNS.map(bold),
    ...entries.map((e) => {
      const v = closeCellValues(e, walletId);
      return CLOSES_CSV_COLUMNS.map((c) => typedCell(CLOSE_CELL_TYPES[c], v[c]));
    }),
  ];
}

const closesSheet = (entries, walletId) => ({
  name: "Closes",
  rows: closesSheetRows(entries, walletId),
  colWidths: [46, 16, 21, 21, 13, 10, 10, 24, 16, 46],
  freeze: { y: 1 },
});

/** series = [{ walletId, snapshots }] — baris per wallet per titik, tanpa
 *  agregat sintetis (alasan yang sama dengan toGroupCurveCsv). */
export function curveSheetRows(series, { granularity, from, to }) {
  return [
    CURVE_CSV_COLUMNS.map(bold),
    ...series.flatMap(({ walletId, snapshots }) =>
      curveSnapshotsIn(snapshots, { granularity, from, to }).map((s) => {
        const v = curveCellValues(s, walletId);
        return CURVE_CSV_COLUMNS.map((c) => typedCell(CURVE_CELL_TYPES[c], v[c]));
      }),
    ),
  ];
}

const curveSheet = (series, opts) => ({
  name: "Kurva",
  rows: curveSheetRows(series, opts),
  colWidths: [21, 46],
  defaultColWidth: 15,
  freeze: { y: 1 },
});

// ─── perakit workbook per jenis laporan ──────────────────────────────

function granularityFor(kind) {
  const gran = config.report.curveGranularity ?? {};
  return kind === "month" ? (gran.month ?? "day")
    : kind === "year" ? (gran.year ?? "week")
    : kind === "ytd" ? (gran.ytd ?? "week")
    : null; // mingguan: tujuh titik tidak membentuk kurva (§09)
}

const granLabel = (g) => (g === "day" ? "harian" : "mingguan");

/**
 * Workbook wallet tunggal — komposisi sheet mengikuti komposisi berkas §09:
 * week → Periode+Closes; month/year → +Kurva; ytd → Periode+Kurva tanpa
 * Closes. Return [{filename, buffer, caption}] (satu entri) agar pengirimnya
 * (sendReportAttachments di index.js) tetap loop sendDocument yang sama.
 */
export function buildReportXlsx(record, { wallet }) {
  const periods = loadPeriods(wallet).periods;
  const sheets = [periodsSheet(periods.map((r) => ({ record: r, scope: "WALLET", walletId: wallet })))];
  const from = Date.parse(record.from);
  const to = Date.parse(record.to);
  const captionParts = [`Periode (${periods.length})`];

  if (record.kind !== "ytd") {
    const entries = closesInWindow(readPerformanceEntries(), from, to);
    sheets.push(closesSheet(entries, wallet));
    captionParts.push(`Closes (${entries.length})`);
  }
  const granularity = granularityFor(record.kind);
  if (granularity) {
    sheets.push(curveSheet([{ walletId: wallet, snapshots: loadSnapshots(wallet).snapshots }], { granularity, from, to }));
    captionParts.push(`Kurva ${granLabel(granularity)}`);
  }
  return [{
    filename: `meridian_report_${record.id}.xlsx`,
    buffer: buildXlsx(sheets),
    caption: `Lampiran ${record.id} — ${captionParts.join(" · ")}`,
  }];
}

/**
 * Workbook GRUP — dikirim primary setelah laporan grup. Periode = union seal
 * semua wallet registry, kolom GROUP dulu lalu per wallet untuk (kind, id)
 * yang sama (collectGroupPeriodItems); Closes tetap wallet SENDIRI (detail
 * close hidup di lessons.json per daemon, tidak diangkut transport ledger);
 * Kurva = baris per wallet dari ledger masing-masing.
 */
export function buildGroupReportXlsx(groupRecord) {
  const registry = loadRegistry();
  const ledgers = registry.wallets.map((w) => ({ w, ...readLedger(w) }));
  const items = collectGroupPeriodItems(registry, ledgers);
  const sheets = [periodsSheet(items)];
  const from = Date.parse(groupRecord.from);
  const to = Date.parse(groupRecord.to);
  const captionParts = [`Periode (${items.length} kolom GROUP+wallet)`];

  if (groupRecord.kind !== "ytd") {
    const own = ledgerWalletAddress();
    const ownId = registry.wallets.find((w) => w.address === own)?.id ?? own;
    const entries = closesInWindow(readPerformanceEntries(), from, to);
    sheets.push(closesSheet(entries, ownId));
    captionParts.push(`Closes wallet ${ownId} (${entries.length})`);
  }
  const granularity = granularityFor(groupRecord.kind);
  if (granularity) {
    const series = walletsActiveIn(from, to, registry).map((w) => ({
      walletId: w.id,
      snapshots: ledgers.find((l) => l.w.id === w.id)?.snapshots ?? [],
    }));
    sheets.push(curveSheet(series, { granularity, from, to }));
    captionParts.push(`Kurva ${granLabel(granularity)} per wallet`);
  }
  return [{
    filename: `meridian_report_${groupRecord.id}.xlsx`,
    buffer: buildXlsx(sheets),
    caption: `Lampiran ${groupRecord.id} — ${captionParts.join(" · ")}`,
  }];
}
