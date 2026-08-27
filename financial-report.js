// financial-report.js — laporan keuangan periode (fase 2: mingguan & bulanan)
// dari seal di ledger. Digunakan oleh cron 00:20/00:30 UTC dan handler /report.
//
// HARD RULE: this module must NEVER import pnl-report.js — that module owns the
// full-history Helius walk, and the zero-walk rule says report code may not be
// one import away from it. Everything here is arithmetic over the ledger files:
// zero Helius, zero RPC.

import { config } from "./config.js";
import {
  sealPeriod,
  loadPeriods,
  ledgerWalletAddress,
  periodBounds,
  lastClosedPeriodId,
} from "./equity-snapshot.js";

const DAY_MS = 24 * 3600 * 1000;

const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/**
 * Find the seal for {kind, id}; seal it first if it is missing (idempotent:
 * an existing seal is NEVER re-sealed here — sealPeriod would throw, and
 * reseal stays an explicit operator action). Returns { wallet, record,
 * sealedNow } — cron/watchdog use sealedNow to decide whether to send.
 */
export function ensurePeriodSealed(kind, id, opts = {}) {
  const wallet = ledgerWalletAddress();
  const existing = loadPeriods(wallet).periods.find((p) => p.kind === kind && p.id === id);
  if (existing) return { wallet, record: existing, sealedNow: false };
  return { wallet, record: sealPeriod(kind, id, opts), sealedNow: true };
}

/** Read-only: the report object for an ALREADY sealed period. */
export function buildPeriodReport({ kind, id }) {
  const wallet = ledgerWalletAddress();
  const record = loadPeriods(wallet).periods.find((p) => p.kind === kind && p.id === id);
  if (!record) {
    throw new Error(
      `Belum ada seal ${kind} ${id} — segel dulu (cron mingguan/bulanan, atau /report ${kind === "week" ? "week" : "month"})`,
    );
  }
  return { wallet, record };
}

const fmtSol = (v, sign = true) =>
  v == null ? "n/a" : `${v < 0 ? "-" : sign ? "+" : ""}${Math.abs(v).toFixed(4)}`;
const fmtUsd = (v, sign = true) =>
  v == null ? "n/a" : `${v < 0 ? "-" : sign ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtPct = (v) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const stampOf = (iso) => String(iso).slice(0, 16).replace("T", " ");

function periodTitle(record) {
  if (record.kind === "week") return `Laporan Mingguan — ${record.id}`;
  if (record.kind === "month") {
    const [y, m] = record.id.split("-").map(Number);
    return `Laporan Bulanan — ${BULAN[m - 1]} ${y}`;
  }
  return `Laporan ${record.kind} — ${record.id}`;
}

/**
 * §06 layout as an aligned <pre> block (the formatPnlReport idiom): Laba Rugi
 * with the signed rows, Ekuitas with the two-sided identity, ROI, Integritas.
 * USD column is derived at sol_price_close; a seal without a price (derived
 * closing snapshot) renders SOL-only. A failed assertion never hides the
 * report — it labels it.
 */
export function formatFinancialReport({ wallet, record }, { html = false } = {}) {
  const p = record.pnl;
  const e = record.equity;
  const sp = record.sol_price_close;
  const hasUsd = Number.isFinite(sp) && sp > 0;

  // rows: label 20 chars, SOL 10, USD 10 (optional)
  const row = (label, sol, usdOverride) => {
    const usd = usdOverride !== undefined ? usdOverride : hasUsd && sol != null ? sol * sp : null;
    return `${label.padEnd(20)}${fmtSol(sol).padStart(10)}${hasUsd ? fmtUsd(usd).padStart(11) : ""}`;
  };
  const eqRow = (label, sol, note) =>
    `${label.padEnd(20)}${fmtSol(sol, false).padStart(10)}${note ? `  ${note}` : ""}`;

  const windowsExpected = Math.round((Date.parse(record.to) - Date.parse(record.from)) / DAY_MS);
  const it = record.integrity;
  const winRate = p.closes > 0 ? Math.round((p.wins / p.closes) * 100) : null;
  const principal = e.modal_posisi_sol != null && e.modal_posisi_rent_sol != null
    ? e.modal_posisi_sol - e.modal_posisi_rent_sol
    : null;
  const assert6ok = !it.assertions_failed.some((a) => a.startsWith("6:"));

  const lines = [
    `${wallet.slice(0, 4)}…${wallet.slice(-4)} · ${stampOf(record.from)} → ${stampOf(record.to)} UTC · disegel ${stampOf(record.sealed_at)}`,
    "",
    `LABA RUGI${" ".repeat(11)}${"SOL".padStart(10)}${hasUsd ? "USD".padStart(11) : ""}`,
    row("Fee LP", p.fee_lp_sol),
    row("Impermanent loss", p.impermanent_loss_sol),
    row("Net Revenue", p.net_revenue_sol),
    "",
    row("Biaya eksekusi", p.exec_cost_sol),
    `  Σ liquidation_gap ${fmtSol(p.exec_cost_measured_sol).padStart(10)}  (terukur)`,
    row("Gas fee", p.gas_fee_sol),
    row("Gross Rill", p.gross_rill_sol),
    "",
    p.llm_cost_usd != null
      ? row("LLM (OpenRouter)", p.llm_cost_sol, p.llm_cost_usd)
      : `${"LLM (OpenRouter)".padEnd(20)}${"n/a".padStart(10)}`,
    row("NET RILL", p.net_rill_sol),
    "",
    "EKUITAS (SOL)",
    eqRow("Saldo awal", e.saldo_awal_sol),
    `${"Deposit".padEnd(20)}${fmtSol(e.deposit_sol).padStart(10)}`,
    `${"Withdrawal".padEnd(20)}${fmtSol(e.withdrawal_sol).padStart(10)}`,
    eqRow("Modal dasar", e.modal_dasar_sol),
    "",
    eqRow("Saldo bebas", e.saldo_bebas_sol),
    eqRow("Modal posisi", e.modal_posisi_sol, principal != null ? `(principal ${principal.toFixed(4)} + rent ${e.modal_posisi_rent_sol.toFixed(4)})` : ""),
    eqRow("Total ekuitas", e.total_ekuitas_sol, hasUsd ? `(${fmtUsd(e.total_ekuitas_sol * sp, false)})` : ""),
    `${"Laba kumulatif".padEnd(20)}${fmtSol(e.laba_kumulatif_sol).padStart(10)}  ${assert6ok ? "✓ ≡ Gross Rill" : "✗ ≠ Gross Rill"}`,
    e.unrealized_pnl_sol != null
      ? `${"  memo nilai pasar".padEnd(20)}${fmtSol(e.modal_posisi_sol + e.unrealized_pnl_sol, false).padStart(10)}`
      : null,
    e.unrealized_pnl_sol != null
      ? `${"  blm direalisasi".padEnd(20)}${fmtSol(e.unrealized_pnl_sol).padStart(10)}${e.unrealized_suspect ? "  ⚠ PnL meragukan" : ""}`
      : e.unrealized_suspect
        ? "  memo nilai pasar   n/a  ⚠ PnL meragukan"
        : null,
    "",
    `${"ROI periode (Dietz)".padEnd(20)}${fmtPct(record.roi.dietz_pct).padStart(10)}`,
    `${"TWR (harian)".padEnd(20)}${fmtPct(record.roi.twr_pct).padStart(10)}`,
    `Closes ${p.closes} | ${p.wins}W/${p.closes - p.wins}L${winRate != null ? ` (${winRate}%)` : ""}`,
    "",
    "INTEGRITAS",
    `Window ${it.windows}/${windowsExpected} ${it.windows === windowsExpected ? "✓" : "✗"} · trusted ${it.all_trusted ? "✓" : "✗"} · drift kum. ${it.cum_drift_sol} SOL`,
  ];
  if (!it.integrity_ok) {
    lines.push(`⚠️ INTEGRITAS: ${it.assertions_failed.length} cek gagal — angka diterbitkan dengan label:`);
    for (const a of it.assertions_failed) lines.push(`  - ${a}`);
  }
  if (hasUsd) lines.push("", `SOL native · USD turunan @ ${sp.toFixed(2)}`);

  const title = `📒 ${periodTitle(record)}`;
  const body = lines.filter((l) => l != null).join("\n");
  if (html) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<b>${esc(title)}</b>\n<pre>${esc(body)}</pre>`;
  }
  return `${title}\n${body}`;
}

export { lastClosedPeriodId, periodBounds };
