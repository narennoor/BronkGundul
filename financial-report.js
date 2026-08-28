// financial-report.js — laporan keuangan periode (fase 2: mingguan & bulanan;
// fase 3: tahunan & YTD) dari ledger. Dipakai cron 00:20/00:30/00:35 UTC dan
// handler /report.
//
// HARD RULE: this module must NEVER import pnl-report.js — that module owns the
// full-history Helius walk, and the zero-walk rule says report code may not be
// one import away from it. Everything here is arithmetic over the ledger files:
// zero Helius, zero RPC.

import { config } from "./config.js";
import { log } from "./logger.js";
import {
  sealPeriod,
  loadPeriods,
  loadSnapshots,
  ledgerWalletAddress,
  periodBounds,
  periodIdFor,
  lastClosedPeriodId,
  dayBoundaryUtc,
  snapshotIdFor,
  snapshotAtOrBefore,
  foldWindows,
  chainDailyTwr,
  llmEndpointDiffUsd,
  ADDITIVE_PNL_ROWS,
  ADDITIVE_EQUITY_ROWS,
} from "./equity-snapshot.js";

const DAY_MS = 24 * 3600 * 1000;
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const r2 = (v) => Math.round(v * 100) / 100;
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/**
 * 1 Januari fires three crons back to back (four when it is a Monday):
 * 00:20 week → 00:30 month (seals December) → 00:35 year. The year seal READS
 * the December seal (assertion 10 + the month chain), so the order is not a
 * nicety — it is structural. This guard makes it structural in CODE: the year
 * path seals any leftover closed month of its year FIRST, ascending so month
 * chains stay right. Covers the cron, the watchdog, and /report year alike.
 * A month that cannot seal (ledger starts mid-year, unhealed gap) is skipped
 * with a log — the year seal then publishes with assertion 10's label.
 */
function sealMissingMonthsOf(wallet, year, now) {
  const sealed = new Set(
    loadPeriods(wallet).periods.filter((p) => p.kind === "month").map((p) => p.id),
  );
  for (let m = 1; m <= 12; m++) {
    const id = `${year}-${String(m).padStart(2, "0")}`;
    if (sealed.has(id)) continue;
    if (periodBounds("month", id).to > now) break; // running/future month
    try {
      sealPeriod("month", id, { now });
      log("ledger", `Seal bulan ${id} tertinggal — disegel sebelum seal tahunan`);
    } catch (e) {
      log("ledger", `Seal bulan ${id} dilewati (${e.message}) — seal tahunan lanjut dengan label`);
    }
  }
}

/**
 * Find the seal for {kind, id}; seal it first if it is missing (idempotent:
 * an existing seal is NEVER re-sealed here — sealPeriod would throw, and
 * reseal stays an explicit operator action). For kind "year", leftover months
 * are sealed first (see sealMissingMonthsOf). Returns { wallet, record,
 * sealedNow } — cron/watchdog use sealedNow to decide whether to send.
 */
export function ensurePeriodSealed(kind, id, opts = {}) {
  const wallet = ledgerWalletAddress();
  const existing = loadPeriods(wallet).periods.find((p) => p.kind === kind && p.id === id);
  if (existing) return { wallet, record: existing, sealedNow: false };
  if (kind === "year") sealMissingMonthsOf(wallet, id, opts.now ?? Date.now());
  return { wallet, record: sealPeriod(kind, id, opts), sealedNow: true };
}

/** Read-only: the report object for an ALREADY sealed period. */
export function buildPeriodReport({ kind, id }) {
  const wallet = ledgerWalletAddress();
  const record = loadPeriods(wallet).periods.find((p) => p.kind === kind && p.id === id);
  if (!record) {
    throw new Error(
      `Belum ada seal ${kind} ${id} — segel dulu (cron mingguan/bulanan/tahunan, atau /report)`,
    );
  }
  return { wallet, record };
}

/**
 * YTD (§04/§07): NEVER sealed, never enters periods.json — it changes every
 * day until the year closes, so sealing it would violate immutability. Its
 * stamp is `as_of`, it has no snapshots_hash, and it costs zero Helius calls
 * whenever asked.
 *
 * Composition: the year's CLOSED months come from their seals; the running
 * month is folded straight from daily snapshots. A closed month whose seal is
 * missing is also folded from snapshots (data beats formality on an unsealed
 * preview) and labeled. Fold rules §04 hold exactly: additive rows summed,
 * endpoints taken from the ends, modal_dasar/win_rate/Dietz RECOMPUTED (Dietz
 * from the exact per-transfer timestamps in the snapshots — seals do not
 * carry timing), TWR chained multiplicatively (associative, so month factors
 * × running-month daily factors ≡ daily chaining).
 *
 * The running form of assertion 10: every additive row is ALSO folded
 * directly from the daily snapshots (lane B) and compared against the
 * seals+running composition (lane A) — two independent lanes that must meet.
 * `integrity.sigma_ok` is that verdict, rendered in the monthly report as
 * "Σ n seal bulanan ≡ YTD".
 */
export function buildYtdReport({ year, now = Date.now() } = {}) {
  year = Number(year);
  if (!Number.isInteger(year) || year < 2000 || year > 3000) {
    throw new Error(`tahun tidak valid: "${year}"`);
  }
  const wallet = ledgerWalletAddress();
  const snapshots = loadSnapshots(wallet).snapshots;
  const periods = loadPeriods(wallet).periods;
  const yearFrom = Date.UTC(year, 0, 1);
  const yearTo = Date.UTC(year + 1, 0, 1);
  if (!snapshots.length) throw new Error("Ledger kosong — belum ada snapshot harian");
  // Data edge: the last snapshot boundary at or before now (clamped to the
  // year) — guarantees the closing endpoint exists and states data recency.
  const edge = snapshotAtOrBefore(snapshots, Math.min(dayBoundaryUtc(now), yearTo));
  if (!edge || Date.parse(edge.boundary_ts) <= yearFrom) {
    throw new Error(`Belum ada data ${year} di ledger`);
  }
  const asOf = Date.parse(edge.boundary_ts);
  const tolDrift = Number(config.report.driftToleranceSol ?? 0.001);
  const assertions = [];
  const note = (s) => assertions.push(s);

  // ── components ──
  const comps = [];
  let monthsSealed = 0;
  for (let m = 0; m < 12; m++) {
    const mFrom = Date.UTC(year, m, 1);
    const mTo = Date.UTC(year, m + 1, 1);
    if (mFrom >= asOf) break;
    const to = Math.min(mTo, asOf);
    const mid = `${year}-${String(m + 1).padStart(2, "0")}`;
    const seal = mTo <= asOf ? periods.find((p) => p.kind === "month" && p.id === mid) : null;
    if (seal) {
      comps.push({ seal });
      monthsSealed++;
      continue;
    }
    let fold = foldWindows(snapshots, mFrom, to);
    let opening = fold.opening;
    if (!opening) {
      const firstIn = snapshots.find((s) => {
        const b = Date.parse(s.boundary_ts);
        return b > mFrom && b <= to;
      });
      if (!firstIn) continue; // month entirely before the ledger — skip
      opening = firstIn;
      fold = foldWindows(snapshots, Date.parse(firstIn.boundary_ts), to);
      note(`ytd:${mid} parsial — ledger mulai ${firstIn.id}`);
    }
    const closing = fold.closing ?? (fold.win.length ? fold.win[fold.win.length - 1] : opening);
    if (!fold.closing) note(`ytd:${mid} snapshot ujung ${snapshotIdFor(to)} hilang — pakai ${closing.id}`);
    if (mTo <= asOf) note(`ytd:${mid} belum disegel — di-fold langsung dari snapshot`);
    comps.push({ fold, opening, closing });
  }
  if (!comps.length) throw new Error(`Belum ada data ${year} di ledger`);

  // ── lane A (published): seals + running fold ──
  const acc = Object.fromEntries([...ADDITIVE_PNL_ROWS, ...ADDITIVE_EQUITY_ROWS].map((k) => [k, 0]));
  let llmUsd = null;
  let twrFactor = 1;
  let windows = 0;
  let allTrusted = true;
  let cumDrift = 0;
  for (const c of comps) {
    if (c.seal) {
      const s = c.seal;
      for (const row of ADDITIVE_PNL_ROWS) acc[row] += s.pnl[row] || 0;
      for (const row of ADDITIVE_EQUITY_ROWS) acc[row] += s.equity[row] || 0;
      if (s.pnl.llm_cost_usd != null) llmUsd = (llmUsd ?? 0) + s.pnl.llm_cost_usd;
      if (s.roi.twr_pct != null) twrFactor *= 1 + s.roi.twr_pct / 100;
      windows += s.integrity.windows;
      allTrusted = allTrusted && s.integrity.all_trusted;
      cumDrift += s.integrity.cum_drift_sol || 0;
    } else {
      const { fold, opening, closing } = c;
      const gross = closing.equity.total_sol - opening.equity.total_sol - (fold.sums.dep - fold.sums.wd);
      acc.fee_lp_sol += fold.sums.feeLp;
      acc.impermanent_loss_sol += fold.sums.netRev - fold.sums.feeLp;
      acc.net_revenue_sol += fold.sums.netRev;
      acc.exec_cost_sol += gross - fold.sums.netRev + fold.sums.gas;
      acc.exec_cost_measured_sol += fold.sums.liqGap;
      acc.gas_fee_sol += -fold.sums.gas;
      acc.gross_rill_sol += gross;
      acc.closes += fold.sums.closes;
      acc.wins += fold.sums.wins;
      acc.deposit_sol += fold.sums.dep;
      acc.withdrawal_sol += -fold.sums.wd;
      const l = llmEndpointDiffUsd(opening, closing);
      if (l != null) llmUsd = (llmUsd ?? 0) + l;
      twrFactor *= chainDailyTwr(opening, fold.win);
      windows += fold.win.length;
      allTrusted = allTrusted && (fold.win.length === 0 || fold.allTrusted);
      cumDrift += fold.cumDrift;
    }
  }

  // ── endpoints (§04: ambil ujung) + recomputed rows ──
  const first = comps[0];
  const last = comps[comps.length - 1];
  const saldoAwal = first.seal ? first.seal.equity.saldo_awal_sol : first.opening.equity.total_sol;
  const eqClose = last.seal
    ? {
        saldo_bebas: last.seal.equity.saldo_bebas_sol,
        modal: last.seal.equity.modal_posisi_sol,
        rent: last.seal.equity.modal_posisi_rent_sol,
        total: last.seal.equity.total_ekuitas_sol,
        unreal: last.seal.equity.unrealized_pnl_sol,
        suspect: last.seal.equity.unrealized_suspect,
        price: last.seal.sol_price_close,
      }
    : {
        saldo_bebas: last.closing.equity.saldo_bebas_sol,
        modal: last.closing.equity.modal_posisi_sol,
        rent: last.closing.equity.rent_sol,
        total: last.closing.equity.total_sol,
        unreal: Number.isFinite(last.closing.market_memo?.nilai_pasar_sol)
          ? r9(last.closing.market_memo.nilai_pasar_sol - last.closing.equity.modal_posisi_sol)
          : null,
        suspect: !!last.closing.market_memo?.suspect,
        price: Number.isFinite(last.closing.sol_price) ? last.closing.sol_price : null,
      };
  const depositSol = r9(acc.deposit_sol);
  const withdrawalSol = r9(acc.withdrawal_sol);
  const modalDasar = r9(saldoAwal + depositSol + withdrawalSol); // recomputed, never summed
  const grossRill = r9(acc.gross_rill_sol);
  const llmSol = llmUsd != null && eqClose.price > 0 ? r9(r2(llmUsd) / eqClose.price) : null;
  const netRill = r9(grossRill + (llmSol ?? 0));
  const labaKumulatif = r9(eqClose.total - modalDasar);
  // Component endpoints must telescope (seal chains + running opening); a gap
  // shows up as laba ≠ Σ gross — the YTD analogue of assertions 6+7.
  if (Math.abs(labaKumulatif - grossRill) > tolDrift) {
    note(`6:laba_kumulatif ${labaKumulatif} != Σ gross_rill ${grossRill} — rantai komponen putus`);
  }

  // ── lane B (sigma — the running assertion 10): direct snapshot fold ──
  const spanFrom = first.seal ? Date.parse(first.seal.from) : Date.parse(first.opening.boundary_ts);
  const direct = foldWindows(snapshots, spanFrom, asOf);
  // spanFrom is either a sealed month's `from` or the first fold component's
  // own opening boundary — a snapshot exists there by construction; the null
  // guard below only defends against a ledger mutated after sealing.
  const dOpen = direct.opening;
  const dClose = direct.closing;
  let sigmaOk = true;
  if (dOpen && dClose) {
    const d = direct.sums;
    const dGross = r9(dClose.equity.total_sol - dOpen.equity.total_sol - (d.dep - d.wd));
    const laneB = {
      fee_lp_sol: r9(d.feeLp),
      impermanent_loss_sol: r9(d.netRev - d.feeLp),
      net_revenue_sol: r9(d.netRev),
      exec_cost_sol: r9(dGross - d.netRev + d.gas),
      exec_cost_measured_sol: r9(d.liqGap),
      gas_fee_sol: r9(-d.gas),
      gross_rill_sol: dGross,
      closes: d.closes,
      wins: d.wins,
      deposit_sol: r9(d.dep),
      withdrawal_sol: r9(-d.wd),
    };
    const tol = Math.max(1e-6, tolDrift);
    for (const row of [...ADDITIVE_PNL_ROWS, ...ADDITIVE_EQUITY_ROWS]) {
      if (Math.abs(laneB[row] - r9(acc[row])) > tol) {
        sigmaOk = false;
        note(`10:${row} Σkomponen ${r9(acc[row])} != fold snapshot ${laneB[row]}`);
      }
    }
    const directLlm = llmEndpointDiffUsd(dOpen, dClose);
    if (llmUsd != null && directLlm != null && Math.abs(directLlm - r2(llmUsd)) > 0.15) {
      sigmaOk = false;
      note(`10:llm_cost_usd Σkomponen ${r2(llmUsd)} != fold snapshot ${directLlm}`);
    }
  }

  // ── ROI: Dietz recomputed from the year's exact flow timings (§04) ──
  const spanMs = asOf - spanFrom;
  let weighted = 0;
  for (const f of direct.timedFlows) {
    weighted += Math.min(1, Math.max(0, (asOf - f.ts * 1000) / spanMs)) * f.sol;
  }
  const dietzBase = saldoAwal + weighted;

  return {
    id: `${year}-YTD`,
    kind: "ytd",
    from: isoZ(yearFrom),
    to: isoZ(asOf),
    as_of: new Date(now).toISOString(), // the stamp — never sealed_at (§07)
    months_sealed: monthsSealed,
    pnl: {
      fee_lp_sol: r9(acc.fee_lp_sol),
      impermanent_loss_sol: r9(acc.impermanent_loss_sol),
      net_revenue_sol: r9(acc.net_revenue_sol),
      exec_cost_sol: r9(acc.exec_cost_sol),
      exec_cost_measured_sol: r9(acc.exec_cost_measured_sol),
      gas_fee_sol: r9(acc.gas_fee_sol),
      gross_rill_sol: grossRill,
      llm_cost_sol: llmSol,
      llm_cost_usd: llmUsd != null ? r2(llmUsd) : null,
      net_rill_sol: netRill,
      closes: acc.closes,
      wins: acc.wins,
    },
    equity: {
      saldo_awal_sol: saldoAwal,
      deposit_sol: depositSol,
      withdrawal_sol: withdrawalSol,
      modal_dasar_sol: modalDasar,
      saldo_bebas_sol: eqClose.saldo_bebas,
      modal_posisi_sol: eqClose.modal,
      modal_posisi_rent_sol: eqClose.rent,
      total_ekuitas_sol: eqClose.total,
      laba_kumulatif_sol: labaKumulatif,
      unrealized_pnl_sol: eqClose.unreal,
      unrealized_suspect: eqClose.suspect,
    },
    roi: {
      dietz_pct: dietzBase > 1e-9 ? Math.round((netRill / dietzBase) * 10000) / 100 : null,
      twr_pct: Math.round((twrFactor - 1) * 10000) / 100,
    },
    integrity: {
      windows,
      all_trusted: allTrusted,
      cum_drift_sol: r9(cumDrift),
      sigma_ok: sigmaOk,
      integrity_ok: assertions.length === 0,
      assertions_failed: assertions,
    },
    sol_price_close: eqClose.price,
    // NO sealed_at, NO snapshots_hash — nothing is frozen here.
  };
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
  if (record.kind === "year") return `Laporan Tahunan — ${record.id}`;
  if (record.kind === "ytd") return `Laporan YTD ${record.id.slice(0, 4)} (berjalan)`;
  return `Laporan ${record.kind} — ${record.id}`;
}

/**
 * §06 layout as an aligned <pre> block (the formatPnlReport idiom): Laba Rugi
 * with the signed rows, Ekuitas with the two-sided identity, ROI, Integritas.
 * USD column is derived at sol_price_close; a record without a price renders
 * SOL-only. A failed assertion never hides the report — it labels it. Pass
 * `ytd` on a monthly report to render the running-YTD strip (§06,
 * `ytdInMonthly`) plus the "Σ n seal bulanan ≡ YTD" check line.
 *
 * A GROUP record (consolidate.js, scope: "GROUP") renders the same statement
 * plus the §06 group blocks: the Per Wallet table, the eliminated-internal
 * line, per-wallet completeness, and the unmatched/price-skew labels. LLM per
 * wallet may be the literal "shared" (same OpenRouter key on both daemons —
 * deduped once at group level, never attributed twice).
 */
export function formatFinancialReport({ wallet, record, ytd = null }, { html = false } = {}) {
  const p = record.pnl;
  const e = record.equity;
  const sp = record.sol_price_close;
  const hasUsd = Number.isFinite(sp) && sp > 0;
  const isYtd = record.kind === "ytd";
  const isGroup = record.scope === "GROUP";

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

  const who = isGroup
    ? `GRUP ${record.group_name ?? ""}`.trim()
    : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  const stamp = record.sealed_at
    ? `disegel ${stampOf(record.sealed_at)}`
    : record.as_of
      ? `as of ${stampOf(record.as_of)}`
      : `disusun ${stampOf(record.generated_at)}`;
  const lines = [
    `${who} · ${stampOf(record.from)} → ${stampOf(record.to)} UTC · ${stamp}`,
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
    isGroup && e.internal_eliminated_sol > 0
      ? `${"  internal dielim.".padEnd(20)}${fmtSol(e.internal_eliminated_sol, false).padStart(10)}  (bukan setoran/penarikan grup)`
      : null,
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
    `${isYtd ? "ROI YTD (Dietz)" : "ROI periode (Dietz)"}`.padEnd(20) + fmtPct(record.roi.dietz_pct).padStart(10),
    `${isYtd ? "TWR YTD" : "TWR (harian)"}`.padEnd(20) + fmtPct(record.roi.twr_pct).padStart(10),
    `Closes ${p.closes} | ${p.wins}W/${p.closes - p.wins}L${winRate != null ? ` (${winRate}%)` : ""}`,
  ];

  // §06: the Per Wallet block — the reason distinct OpenRouter keys matter
  // (per-wallet Net Rill is only comparable when LLM attribution is exact).
  if (isGroup && Array.isArray(record.wallets)) {
    lines.push("", `PER WALLET${" ".repeat(10)}${"NET RILL".padStart(10)}${"ROI".padStart(9)}`);
    for (const w of record.wallets) {
      const marks = [
        w.llm_cost_usd === "shared" ? "LLM shared" : null,
        !w.sealed ? "belum seal" : null,
        !w.complete ? `${w.missing_dates} hari bolong` : null,
      ].filter(Boolean);
      lines.push(
        `${String(w.label).slice(0, 20).padEnd(20)}${fmtSol(w.net_rill_sol).padStart(10)}${fmtPct(w.dietz_pct).padStart(9)}${marks.length ? `  (${marks.join(", ")})` : ""}`,
      );
    }
    lines.push(`${"Grup".padEnd(20)}${fmtSol(p.net_rill_sol).padStart(10)}${fmtPct(record.roi.dietz_pct).padStart(9)}`);
  }

  // running-YTD strip on the monthly report (§06, ytdInMonthly) — the strip
  // may be a wallet YTD (buildYtdReport) or a group YTD (consolidatePeriod)
  if (ytd) {
    const yp = ytd.pnl;
    lines.push(
      "",
      `YTD BERJALAN · ${stampOf(ytd.from).slice(0, 10)} → ${stampOf(ytd.to).slice(0, 10)}`,
      `${"Net Rill".padEnd(20)}${fmtSol(yp.net_rill_sol).padStart(10)}`,
      `${"ROI YTD (Dietz)".padEnd(20)}${fmtPct(ytd.roi.dietz_pct).padStart(10)}`,
      `${"TWR YTD".padEnd(20)}${fmtPct(ytd.roi.twr_pct).padStart(10)}`,
      ytd.scope === "GROUP"
        ? `  grup · as of ${stampOf(ytd.as_of)}`
        : `  ${ytd.months_sealed} bulan tersegel · as of ${stampOf(ytd.as_of)}`,
    );
  }

  lines.push("", "INTEGRITAS");
  if (isGroup) {
    const expected = it.windows_expected ?? windowsExpected;
    lines.push(
      `Window lengkap ${it.windows}/${expected} ${it.complete ? "✓" : "✗"} · trusted ${it.all_trusted ? "✓" : "✗"} · drift kum. ${it.cum_drift_sol} SOL`,
      `Wallet lengkap: ${record.wallets.map((w) => `${w.label} ${w.complete ? "✓" : `✗(${w.missing_dates}h)`}`).join(" · ")}`,
    );
    if (e.internal_eliminated_sol > 0) {
      lines.push(`Transfer internal ${e.internal_eliminated_sol.toFixed(4)} SOL dieliminasi (${record.internal_transfers.length} pasangan)`);
    }
    if (record.unmatched_internal.length) {
      lines.push(`⚠ ${record.unmatched_internal.length} transfer internal tak berpasangan — dihitung sebagai flow eksternal`);
    }
    if (record.llm_shared_keys?.length) {
      lines.push(`⚠ LLM key dipakai bersama (${record.llm_shared_keys.length}) — biaya dihitung sekali, kolom wallet = shared`);
    }
    if (record.price_skew_pct != null) {
      lines.push(`⚠ Harga SOL antar wallet menyimpang ${record.price_skew_pct}% — grup memakai harga primary`);
    }
  } else if (isYtd) {
    lines.push(
      `Bulan tersegel ${record.months_sealed} · window ${it.windows} · trusted ${it.all_trusted ? "✓" : "✗"} · drift kum. ${it.cum_drift_sol} SOL`,
      `Σ ${record.months_sealed} seal bulanan ≡ fold snapshot ${it.sigma_ok ? "✓" : "✗"}`,
    );
  } else {
    lines.push(
      `Window ${it.windows}/${windowsExpected} ${it.windows === windowsExpected ? "✓" : "✗"} · trusted ${it.all_trusted ? "✓" : "✗"} · drift kum. ${it.cum_drift_sol} SOL`,
    );
  }
  if (ytd && ytd.scope !== "GROUP") {
    lines.push(`Σ ${ytd.months_sealed} seal bulanan ≡ YTD ${ytd.integrity.sigma_ok ? "✓" : "✗"}`);
  }
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

export { lastClosedPeriodId, periodBounds, periodIdFor };
