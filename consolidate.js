// consolidate.js — konsolidasi multi-wallet (fase 5, §08).
//
// consolidatePeriod() folds N wallet ledgers into ONE group record: pure
// arithmetic over local files — zero Helius, zero RPC — and purely a READER
// (every daemon writes exactly one ledger, its own; group records are never
// persisted, they are recomputed on demand and stay deterministic).
//
// HARD RULE: this module must NEVER import pnl-report.js (the zero-walk rule —
// that module owns the full-history walk).
//
// The four non-trivial §08 rules, all implemented here:
//
//  1. INTERNAL-TRANSFER ELIMINATION pairs the two sides of a transfer between
//     group wallets by SIGNATURE — never by amount + time: one tx has an out
//     side and an in side under the same sig, so the match is certain. A side
//     with no partner (destination not yet in the registry, or its daemon was
//     down and the window is missing) goes to unmatched_internal[] and stays
//     an EXTERNAL flow — visible, never silently dropped. The GAS of an
//     internal transfer is a real group cost and is NOT eliminated.
//
//  2. LLM DEDUP groups by llm_key_id: one key = one cost, once. The daemons
//     run different OpenRouter keys, so per-wallet attribution is exact; the
//     dedup stays wired as a safety net — if two wallets ever share a key its
//     cost counts once and their per-wallet column reads "shared" instead of
//     double-counting silently.
//
//  3. ONE SOL PRICE PER BOUNDARY, taken from the primary wallet — the group's
//     headline numbers are SOL-native, USD stays derived (config
//     report.groupPriceSource, "primary" is the only implemented source).
//     price_skew_pct is recorded when the wallets' closing prices diverge past
//     PRICE_SKEW_NOTE_PCT — the tell for a snapshot taken far off its time.
//
//  4. COMPLETENESS: a group date is complete only when EVERY wallet active on
//     it has that snapshot. The report still publishes when one is missing —
//     with complete: false and wallets_missing[], never by silently summing
//     whatever exists as if it were whole.
//
// Mid-history joins (§08 active_from): a wallet whose data enters the group
// inside the period contributes its opening equity as a GROUP DEPOSIT at that
// boundary (joining_capital[]) — otherwise it would land in gross_rill as
// phantom profit — EXCEPT the part that came from a group wallet: an unmatched
// out-transfer to the joiner dated at/before its entry is re-paired against
// that capital ("join_funding") and eliminated. Retirement (active_to inside
// the period) is symmetric: the last equity leaves as a group WITHDRAWAL
// (retiring_capital[]).

import { config } from "./config.js";
import { loadRegistry, walletsActiveIn, activeWalletsAt, activeBoundsMs, ownAddressSet } from "./ledger-registry.js";
import { readLedger } from "./ledger-transport.js";
import {
  periodBounds,
  dayBoundaryUtc,
  snapshotIdFor,
  snapshotAtOrBefore,
  foldWindows,
  llmEndpointDiffUsd,
  ADDITIVE_PNL_ROWS,
} from "./equity-snapshot.js";

const DAY_MS = 24 * 3600 * 1000;
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const r2 = (v) => Math.round(v * 100) / 100;
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// Closing-price divergence between wallets beyond this ⇒ record price_skew_pct.
const PRICE_SKEW_NOTE_PCT = 1;

// ─── eliminasi transfer internal (§08) ───────────────────────────────

/**
 * Pair internal transfers by SIGNATURE. Input: every transfer of the period
 * across all wallets, each tagged { wallet_id, wallet_address } by the caller.
 *
 * Returns:
 *   external  — counterparty is not a group wallet; untouched.
 *   internal  — matched pairs [{ sig, ts, from_wallet, to_wallet, amount_sol }],
 *               both sides excluded from group deposit/withdrawal.
 *   unmatched — internal-candidate sides with no partner; the caller treats
 *               them as EXTERNAL flow (visible, never dropped) and assertion 9
 *               flags them.
 *
 * A tx can carry several native transfers under one sig, so matching is
 * greedy within a sig group: an "in" on wallet X pairs with an "out" on
 * wallet Y when the amounts agree and the counterparties point at each other.
 * Gas is untouched here by construction — it lives in flows.gas_sol, not in
 * transfers[].
 */
export function eliminateInternalTransfers(transfers, ownAddresses, { tolerance = 1e-9 } = {}) {
  const external = [];
  const bySig = new Map();
  for (const t of transfers) {
    if (!ownAddresses.has(t.counterparty)) {
      external.push(t);
      continue;
    }
    if (!bySig.has(t.sig)) bySig.set(t.sig, []);
    bySig.get(t.sig).push(t);
  }
  const internal = [];
  const unmatched = [];
  for (const [sig, list] of bySig) {
    const ins = list.filter((t) => t.dir === "in");
    const outs = list.filter((t) => t.dir === "out");
    const usedOut = new Array(outs.length).fill(false);
    for (const tin of ins) {
      const j = outs.findIndex(
        (tout, k) =>
          !usedOut[k] &&
          tout.wallet_address !== tin.wallet_address &&
          tout.counterparty === tin.wallet_address &&
          tin.counterparty === tout.wallet_address &&
          Math.abs(tout.amount_sol - tin.amount_sol) <= tolerance,
      );
      if (j >= 0) {
        usedOut[j] = true;
        internal.push({
          sig,
          ts: tin.ts,
          from_wallet: outs[j].wallet_id,
          to_wallet: tin.wallet_id,
          amount_sol: tin.amount_sol,
        });
      } else {
        unmatched.push(tin);
      }
    }
    outs.forEach((t, k) => {
      if (!usedOut[k]) unmatched.push(t);
    });
  }
  return { external, internal, unmatched };
}

// ─── dedup biaya LLM (§08) ───────────────────────────────────────────

/**
 * One llm_key_id = one cost, once. entries: [{ wallet_id, opening, closing }]
 * (snapshot endpoints — seals do not carry the key id, snapshots do).
 *
 * totalUsd sums ONE endpoint diff per distinct key; for a key held by several
 * wallets the WIDEST reading wins (readings are taken minutes apart, the
 * widest covers the union) and each of those wallets' per-wallet value
 * becomes the literal string "shared" — never a double-counted number.
 */
export function dedupLlmCost(entries) {
  const byWallet = {};
  const keyDiff = new Map();
  const keyWallets = new Map();
  for (const e of entries) {
    const usd = llmEndpointDiffUsd(e.opening, e.closing); // negatif atau null
    const key = e.closing?.llm_key_id ?? e.opening?.llm_key_id ?? null;
    byWallet[e.wallet_id] = { usd, key };
    if (usd != null && key) {
      keyWallets.set(key, [...(keyWallets.get(key) ?? []), e.wallet_id]);
      const prev = keyDiff.get(key);
      keyDiff.set(key, prev == null ? usd : Math.min(prev, usd)); // biaya negatif — min = terlebar
    }
  }
  const sharedKeys = [...keyWallets.entries()].filter(([, ws]) => ws.length > 1).map(([k]) => k);
  let totalUsd = null;
  for (const usd of keyDiff.values()) totalUsd = (totalUsd ?? 0) + usd;
  const perWallet = {};
  for (const [wid, { usd, key }] of Object.entries(byWallet)) {
    perWallet[wid] = key && sharedKeys.includes(key) ? "shared" : usd;
  }
  return { totalUsd: totalUsd != null ? r2(totalUsd) : null, perWallet, sharedKeys };
}

// ─── konsolidasi satu periode ────────────────────────────────────────

/**
 * The group record for one period — §07's seal shape plus the group fields
 * (scope, wallets[], internal_transfers[], unmatched_internal[],
 * equity.internal_eliminated_sol, integrity.complete/wallets_missing). Never
 * sealed, never persisted: kinds week/month/year are stamped generated_at,
 * kind "ytd" is stamped as_of (id may be "YYYY", YYYY, or "YYYY-YTD").
 *
 * Two computation lanes on purpose: the group numbers come from the MERGED
 * daily series (transfers[] detail, endpoint totals), the per-wallet block
 * from each wallet's own seal (or a per-wallet fold when unsealed) — so
 * assertion 8 (Σ wallet == GROUP per additive row) is a real cross-check, and
 * the deposit/withdrawal scalars are verified against the transfer DETAIL the
 * group lane was built from. Assertion 9 (Σ internal ≈ 0) fails exactly when
 * a transfer was recorded on one side only (a daemon down mid-transfer).
 *
 * All assertion failures LABEL the record (integrity_ok=false +
 * assertions_failed[]) — they never throw; what does throw is having no data
 * at all to consolidate.
 */
export function consolidatePeriod({ kind, id, now = Date.now(), registry = null } = {}) {
  registry ??= loadRegistry();
  const isYtd = kind === "ytd";
  let from, to;
  if (isYtd) {
    const year = Number(String(id ?? "").slice(0, 4)) || new Date(now).getUTCFullYear();
    from = Date.UTC(year, 0, 1);
    to = Math.min(Date.UTC(year + 1, 0, 1), dayBoundaryUtc(now));
    id = `${year}-YTD`;
    if (to <= from) throw new Error(`Belum ada hari yang tutup di ${year}`);
  } else {
    ({ from, to } = periodBounds(kind, id)); // validates kind + id
  }
  const driftTol = Number(config.report.driftToleranceSol ?? 0.001);
  const priceSource = config.report.groupPriceSource ?? "primary";
  const assertions = [];
  const note = (s) => assertions.push(s);
  const eq = (x, y, tol = 1e-9) => Math.abs(x - y) <= tol;

  const wallets = walletsActiveIn(from, to, registry);
  if (!wallets.length) throw new Error(`Registry: tidak ada wallet aktif dalam ${kind} ${id}`);

  // ── per-wallet lane: endpoints, fold, transfers, seal ──
  const perWallet = [];
  const walletsMissing = new Set();
  for (const w of wallets) {
    const { snapshots, periods } = readLedger(w);
    const [aFrom, aTo] = activeBoundsMs(w);
    const wFrom = Math.max(from, aFrom);
    const wTo = aTo != null ? Math.min(to, aTo) : to;
    const retired = aTo != null && aTo < to;
    if (!snapshots.length) {
      walletsMissing.add(w.id);
      note(`grup:${w.id} ledger kosong — angka grup parsial`);
      continue;
    }
    // Opening: the exact wFrom boundary; else the latest before it (labeled);
    // else the wallet's data ENTERS the group inside this period → joining.
    let opening = snapshots.find((s) => Date.parse(s.boundary_ts) === wFrom) ?? null;
    if (!opening) {
      opening = snapshotAtOrBefore(snapshots, wFrom);
      if (opening) note(`grup:${w.id} snapshot ${snapshotIdFor(wFrom)} hilang — opening pakai ${opening.id}`);
    }
    if (!opening) {
      opening =
        snapshots.find((s) => {
          const b = Date.parse(s.boundary_ts);
          return b > wFrom && b <= wTo;
        }) ?? null;
      if (!opening) {
        walletsMissing.add(w.id);
        note(`grup:${w.id} tidak punya snapshot dalam periode — angka grup parsial`);
        continue;
      }
    }
    const oMs = Date.parse(opening.boundary_ts);
    // §08: capital present at a mid-period entry is a GROUP DEPOSIT, not
    // phantom gross_rill. Trigger is the effective opening boundary, so it
    // covers both a registry mid-join and a not-yet-seeded ledger (labeled).
    const joining =
      oMs > from
        ? { wallet_id: w.id, address: w.address, ts: oMs / 1000, snapshot_id: opening.id, amount_sol: opening.equity.total_sol }
        : null;
    if (joining && aFrom <= from) note(`grup:${w.id} ledger mulai ${opening.id} — modal awal masuk sebagai setoran grup`);

    let closing = snapshots.find((s) => Date.parse(s.boundary_ts) === wTo) ?? null;
    if (!closing) {
      closing = snapshotAtOrBefore(snapshots, wTo) ?? opening;
      if (!retired) note(`grup:${w.id} snapshot ujung ${snapshotIdFor(wTo)} hilang — closing pakai ${closing.id}`);
    }
    const cMs = Date.parse(closing.boundary_ts);
    // Retirement is registry-declared ONLY — a merely-missing closing snapshot
    // must never read as capital leaving the group.
    const retiring = retired
      ? { wallet_id: w.id, address: w.address, ts: cMs / 1000, snapshot_id: closing.id, amount_sol: closing.equity.total_sol }
      : null;

    const fold = foldWindows(snapshots, oMs, cMs);
    const transfers = [];
    for (const s of fold.win) {
      for (const t of s.flows.transfers || []) {
        transfers.push({ ...t, wallet_id: w.id, wallet_address: w.address });
      }
    }
    // Completeness per §08: every date the registry says this wallet is active
    // must have its snapshot — pre-genesis dates of an unseeded ledger count
    // as missing (honest), a registry mid-join starting at its genesis does not.
    const have = new Set(snapshots.map((s) => s.id));
    let missingDates = 0;
    for (let b = wFrom; b <= wTo; b += DAY_MS) {
      if (!have.has(snapshotIdFor(b))) missingDates++;
    }
    if (missingDates > 0) walletsMissing.add(w.id);

    const seal = !isYtd ? periods.find((p) => p.kind === kind && p.id === id) ?? null : null;
    perWallet.push({ w, snapshots, opening, closing, oMs, cMs, fold, transfers, seal, joining, retiring, missingDates });
  }
  if (!perWallet.length) throw new Error(`Tidak ada data ledger untuk ${kind} ${id} — semua wallet kosong`);

  // ── merged scalar sums (lane: per-snapshot scalars) ──
  const S = { dep: 0, wd: 0, gas: 0, feeLp: 0, netRev: 0, liqGap: 0, closes: 0, wins: 0 };
  for (const p of perWallet) for (const k of Object.keys(S)) S[k] += p.fold.sums[k];

  // ── elimination (lane: transfers[] detail) ──
  const own = ownAddressSet(registry);
  const elim = eliminateInternalTransfers(
    perWallet.flatMap((p) => p.transfers),
    own,
  );

  // Join funding (§08 "kecuali dananya datang dari wallet sendiri"): an
  // unmatched OUT to a joining wallet, dated at/before its entry, is the
  // joiner's capital leaving a sibling — re-pair it against joining_capital.
  const joinings = perWallet.filter((p) => p.joining).map((p) => ({ ...p.joining, remaining: p.joining.amount_sol }));
  const joinFunding = [];
  let unmatched = elim.unmatched;
  for (const j of joinings) {
    unmatched = unmatched.filter((u) => {
      const fundsJoiner =
        u.dir === "out" && u.counterparty === j.address && u.wallet_address !== j.address &&
        u.ts <= j.ts && u.amount_sol <= j.remaining + 1e-9;
      if (!fundsJoiner) return true;
      j.remaining = r9(j.remaining - u.amount_sol);
      joinFunding.push({
        sig: u.sig,
        ts: u.ts,
        from_wallet: u.wallet_id,
        to_wallet: j.wallet_id,
        amount_sol: u.amount_sol,
        kind: "join_funding",
      });
      return false;
    });
  }
  const retirings = perWallet.filter((p) => p.retiring).map((p) => p.retiring);

  // ── group flows, from the transfer DETAIL (independent of the scalars) ──
  const extIn = r9(
    [...elim.external, ...unmatched].filter((t) => t.dir === "in").reduce((s, t) => s + t.amount_sol, 0),
  );
  const extOut = r9(
    [...elim.external, ...unmatched].filter((t) => t.dir === "out").reduce((s, t) => s + t.amount_sol, 0),
  );
  const joiningNet = r9(joinings.reduce((s, j) => s + j.remaining, 0));
  const retiringSol = r9(retirings.reduce((s, x) => s + x.amount_sol, 0));
  const matchedSol = r9(elim.internal.reduce((s, t) => s + t.amount_sol, 0));
  const joinFundingSol = r9(joinFunding.reduce((s, t) => s + t.amount_sol, 0));

  const depositSol = r9(extIn + joiningNet);
  const withdrawalSol = r9(-(extOut + retiringSol));
  const internalEliminatedSol = r9(matchedSol + joinFundingSol);

  // ── equity endpoints (joiners enter via deposit, retirees exit via withdrawal) ──
  const saldoAwal = r9(perWallet.reduce((s, p) => s + (p.joining ? 0 : p.opening.equity.total_sol), 0));
  const closers = perWallet.filter((p) => !p.retiring);
  const totalEkuitas = r9(closers.reduce((s, p) => s + p.closing.equity.total_sol, 0));
  const saldoBebas = r9(closers.reduce((s, p) => s + p.closing.equity.saldo_bebas_sol, 0));
  const modalPosisi = r9(closers.reduce((s, p) => s + p.closing.equity.modal_posisi_sol, 0));
  const rentSol = r9(closers.reduce((s, p) => s + (p.closing.equity.rent_sol || 0), 0));
  const modalDasar = r9(saldoAwal + depositSol + withdrawalSol);
  const grossRill = r9(totalEkuitas - saldoAwal - (depositSol + withdrawalSol));
  const labaKumulatif = r9(totalEkuitas - modalDasar);

  const feeLpSol = r9(S.feeLp);
  const netRevenueSol = r9(S.netRev);
  const ilSol = r9(netRevenueSol - feeLpSol);
  const gasFeeSol = r9(-S.gas);
  const execCost = r9(grossRill - netRevenueSol - gasFeeSol);

  // memo nilai pasar: dijumlahkan bila diketahui; satu wallet suspect ⇒ suspect
  let unrealized = null;
  let unrealSuspect = false;
  for (const p of closers) {
    const mm = p.closing.market_memo || {};
    if (Number.isFinite(mm.nilai_pasar_sol)) {
      unrealized = r9((unrealized ?? 0) + (mm.nilai_pasar_sol - p.closing.equity.modal_posisi_sol));
    } else if (p.closing.equity.modal_posisi_sol > 0) {
      unrealSuspect = true;
    }
    if (mm.suspect) unrealSuspect = true;
  }

  // ── §08: one price per boundary, from the primary wallet ──
  const priceOf = (p) => (Number.isFinite(p?.closing?.sol_price) ? p.closing.sol_price : null);
  const primaryEntry =
    priceSource === "primary" ? perWallet.find((p) => p.w.id === registry.primary) ?? null : null;
  const solPriceClose = priceOf(primaryEntry) ?? perWallet.map(priceOf).find((v) => v != null) ?? null;
  let priceSkewPct = null;
  if (solPriceClose > 0) {
    for (const p of perWallet) {
      const v = priceOf(p);
      if (v == null) continue;
      const skew = r2((Math.abs(v - solPriceClose) / solPriceClose) * 100);
      if (skew > PRICE_SKEW_NOTE_PCT && (priceSkewPct == null || skew > priceSkewPct)) priceSkewPct = skew;
    }
  }

  // ── LLM dedup ──
  const llm = dedupLlmCost(perWallet.map((p) => ({ wallet_id: p.w.id, opening: p.opening, closing: p.closing })));
  const llmUsd = llm.totalUsd;
  const llmSol = llmUsd != null && solPriceClose > 0 ? r9(llmUsd / solPriceClose) : null;
  const netRill = r9(grossRill + (llmSol ?? 0));

  // ── completeness (§08): every active wallet, every date ──
  let expectedWindows = 0;
  let completeWindows = 0;
  for (let b = from + DAY_MS; b <= to; b += DAY_MS) {
    const activeHere = activeWalletsAt(b - 1, registry); // aktif pada window (b−1hari, b]
    if (!activeHere.length) continue;
    expectedWindows++;
    const allHave = activeHere.every((w) => {
      const p = perWallet.find((x) => x.w.id === w.id);
      return p && p.snapshots.some((s) => s.id === snapshotIdFor(b));
    });
    if (allHave) completeWindows++;
  }
  const complete = walletsMissing.size === 0 && completeWindows === expectedWindows;

  // ── group daily series: TWR + Dietz dari flow eksternal bertanda waktu ──
  const timedExtFlows = [
    ...[...elim.external, ...unmatched].map((t) => ({ ts: t.ts, sol: t.dir === "in" ? t.amount_sol : -t.amount_sol })),
    ...joinings.filter((j) => j.remaining > 1e-9).map((j) => ({ ts: j.ts, sol: j.remaining })),
    ...retirings.map((x) => ({ ts: x.ts, sol: -x.amount_sol })),
  ];
  const byBoundary = perWallet.map((p) => {
    const m = new Map();
    for (const s of p.snapshots) {
      const b = Date.parse(s.boundary_ts);
      if (b >= p.oMs && b <= p.cMs) m.set(b, s);
    }
    return { p, m };
  });
  const totalAt = (b) => {
    let t = 0;
    for (const { p, m } of byBoundary) {
      if (b < p.oMs || (p.retiring && b > p.cMs)) continue;
      const s = m.get(b) ?? snapshotAtOrBefore(p.snapshots, Math.min(b, p.cMs));
      if (s) t += s.equity.total_sol;
    }
    return t;
  };
  let twrFactor = 1;
  let prevT = totalAt(from);
  const prevSnapOf = new Map(); // wallet_id → snapshot hari sebelumnya (untuk diff LLM harian)
  for (const { p, m } of byBoundary) prevSnapOf.set(p.w.id, m.get(from) ?? null);
  for (let b = from + DAY_MS; b <= to; b += DAY_MS) {
    const Tb = totalAt(b);
    const loSec = (b - DAY_MS) / 1000;
    const hiSec = b / 1000;
    const flowNet = timedExtFlows
      .filter((f) => f.ts > loSec && f.ts <= hiSec)
      .reduce((s, f) => s + f.sol, 0);
    // LLM hari itu: diff lifetime per KEY unik (dedup), diharga pada boundary
    let llmDaySol = 0;
    const seenKeys = new Set();
    const priceHere =
      (primaryEntry && Number.isFinite(byBoundary.find((x) => x.p === primaryEntry)?.m.get(b)?.sol_price)
        ? byBoundary.find((x) => x.p === primaryEntry).m.get(b).sol_price
        : null) ?? solPriceClose;
    for (const { p, m } of byBoundary) {
      const cur = m.get(b);
      const prev = prevSnapOf.get(p.w.id);
      if (
        cur && prev && cur.llm_key_id && cur.llm_key_id === prev.llm_key_id && !seenKeys.has(cur.llm_key_id) &&
        Number.isFinite(cur.llm_usd_lifetime) && Number.isFinite(prev.llm_usd_lifetime) && priceHere > 0
      ) {
        seenKeys.add(cur.llm_key_id);
        llmDaySol += Math.max(0, cur.llm_usd_lifetime - prev.llm_usd_lifetime) / priceHere;
      }
      if (cur) prevSnapOf.set(p.w.id, cur);
    }
    const base = prevT + flowNet;
    if (base > 1e-9) twrFactor *= 1 + (Tb - prevT - flowNet - llmDaySol) / base;
    prevT = Tb;
  }
  // Jendela bobot Dietz mulai dari AKTIVITAS PERTAMA grup yang TEREKAM
  // ledger (boundary snapshot pembuka paling awal di antara wallet periode
  // ini), bukan awal kalender periode — sejajar dengan spanFrom di
  // buildYtdReport level wallet. Tanpa jangkar ini, YTD tahun genesis
  // (ledger mulai 21 Jul) merentang Jan–Agu: modal gabung berbobot ~0,16
  // dan Dietz meledak (−210% saat kerugian riil −33%, 28 Agu 2026). Flow
  // pada/sebelum jangkar berbobot penuh — modal itu hadir sepanjang jendela
  // aktif; saldoAwal tetap dari opening non-joining (0 saat grup lahir di
  // tengah periode) supaya tidak double-count dengan setoran gabung.
  // Periode normal (wallet aktif sejak boundary pembuka) tidak berubah:
  // oMs == from. Ledger yang di-backfill mundur menggeser jangkar ini
  // otomatis pada perhitungan berikutnya (record grup tak pernah disegel).
  const activityStartMs = perWallet.length
    ? Math.max(from, Math.min(...perWallet.map((p) => p.oMs)))
    : from;
  const spanMs = Math.max(1, to - activityStartMs);
  let weighted = 0;
  for (const f of timedExtFlows) {
    weighted += Math.min(1, Math.max(0, (to - f.ts * 1000) / spanMs)) * f.sol;
  }
  const dietzBase = saldoAwal + weighted;

  // ── blok per-wallet: seal bila ada, fold bila belum (dua lane assertion 8) ──
  const walletRows = perWallet.map((p) => {
    const llmVal = llm.perWallet[p.w.id]; // usd (negatif) | "shared" | null
    let row;
    if (p.seal) {
      row = {
        fee_lp_sol: p.seal.pnl.fee_lp_sol,
        impermanent_loss_sol: p.seal.pnl.impermanent_loss_sol,
        net_revenue_sol: p.seal.pnl.net_revenue_sol,
        exec_cost_sol: p.seal.pnl.exec_cost_sol,
        exec_cost_measured_sol: p.seal.pnl.exec_cost_measured_sol,
        gas_fee_sol: p.seal.pnl.gas_fee_sol,
        gross_rill_sol: p.seal.pnl.gross_rill_sol,
        closes: p.seal.pnl.closes,
        wins: p.seal.pnl.wins,
        deposit_sol: p.seal.equity.deposit_sol,
        withdrawal_sol: p.seal.equity.withdrawal_sol,
        dietz_pct: p.seal.roi.dietz_pct,
        twr_pct: p.seal.roi.twr_pct,
      };
    } else {
      const f = p.fold.sums;
      const gross = r9(p.closing.equity.total_sol - p.opening.equity.total_sol - (f.dep - f.wd));
      const wNetRillPreview = r9(gross + (typeof llmVal === "number" && solPriceClose > 0 ? llmVal / solPriceClose : 0));
      let wWeighted = 0;
      for (const t of p.fold.timedFlows) {
        wWeighted += Math.min(1, Math.max(0, (p.cMs - t.ts * 1000) / Math.max(1, p.cMs - p.oMs))) * t.sol;
      }
      const wBase = p.opening.equity.total_sol + wWeighted;
      row = {
        fee_lp_sol: r9(f.feeLp),
        impermanent_loss_sol: r9(f.netRev - f.feeLp),
        net_revenue_sol: r9(f.netRev),
        exec_cost_sol: r9(gross - f.netRev + f.gas),
        exec_cost_measured_sol: r9(f.liqGap),
        gas_fee_sol: r9(-f.gas),
        gross_rill_sol: gross,
        closes: f.closes,
        wins: f.wins,
        deposit_sol: r9(f.dep),
        withdrawal_sol: r9(-f.wd),
        dietz_pct: wBase > 1e-9 ? Math.round((wNetRillPreview / wBase) * 10000) / 100 : null,
        twr_pct: null, // pratinjau tanpa seal — TWR wallet menyusul saat tersegel
      };
    }
    const llmSolW = typeof llmVal === "number" && solPriceClose > 0 ? r9(llmVal / solPriceClose) : null;
    return {
      wallet_id: p.w.id,
      label: p.w.label ?? p.w.id,
      sealed: !!p.seal,
      ...row,
      llm_cost_usd: llmVal ?? null, // angka, "shared", atau null
      llm_cost_sol: llmVal === "shared" ? "shared" : llmSolW,
      net_rill_sol: r9(row.gross_rill_sol + (llmVal === "shared" || llmVal == null ? 0 : (llmSolW ?? 0))),
      total_ekuitas_sol: p.closing.equity.total_sol,
      complete: !walletsMissing.has(p.w.id),
      missing_dates: p.missingDates,
    };
  });

  // ── assertions 1–6 (identitas grup), 8, 9 (§10) ──
  if (!eq(netRevenueSol, r9(feeLpSol + ilSol))) note(`1:net_revenue ${netRevenueSol} != fee_lp+il ${r9(feeLpSol + ilSol)}`);
  if (!eq(grossRill, r9(netRevenueSol + execCost + gasFeeSol))) note(`2:gross_rill ${grossRill} != net_revenue+exec+gas`);
  if (!eq(netRill, r9(grossRill + (llmSol ?? 0)))) note(`3:net_rill ${netRill} != gross_rill+llm`);
  if (!eq(modalDasar, r9(saldoAwal + depositSol + withdrawalSol))) note(`4:modal_dasar ${modalDasar} != saldo_awal+deposit+withdrawal`);
  if (!eq(totalEkuitas, r9(saldoBebas + modalPosisi), driftTol)) note(`5:total_ekuitas ${totalEkuitas} != saldo_bebas+modal_posisi ${r9(saldoBebas + modalPosisi)}`);
  if (!eq(labaKumulatif, grossRill, driftTol)) note(`6:laba_kumulatif ${labaKumulatif} != gross_rill ${grossRill}`);

  // 8: Σ wallet == GROUP untuk tiap baris aditif — lane per-wallet (seal/fold)
  // vs lane grup (seri gabungan). Deposit/withdrawal dicek terhadap DETAIL
  // transfer: skalar snapshot dan transfers[] wajib menceritakan angka yang
  // sama, lalu relasi eliminasi/joining wajib menjelaskan selisih grupnya.
  const tol8 = Math.max(1e-6, driftTol);
  for (const rowName of ADDITIVE_PNL_ROWS) {
    const sum = r9(walletRows.reduce((s, r) => s + (r[rowName] || 0), 0));
    const groupVal = {
      fee_lp_sol: feeLpSol,
      impermanent_loss_sol: ilSol,
      net_revenue_sol: netRevenueSol,
      exec_cost_sol: execCost,
      exec_cost_measured_sol: r9(S.liqGap),
      gas_fee_sol: gasFeeSol,
      gross_rill_sol: grossRill,
      closes: S.closes,
      wins: S.wins,
    }[rowName];
    if (!eq(sum, groupVal, tol8)) note(`8:${rowName} Σwallet ${sum} != grup ${groupVal}`);
  }
  const sumDepScalar = r9(S.dep);
  const detailIn = r9(extIn + matchedSol); // semua transfer masuk menurut detail
  if (!eq(sumDepScalar, detailIn, tol8)) note(`8:deposit skalar Σwallet ${sumDepScalar} != detail transfers ${detailIn}`);
  const sumWdScalar = r9(S.wd);
  const detailOut = r9(extOut + matchedSol + joinFundingSol);
  if (!eq(sumWdScalar, detailOut, tol8)) note(`8:withdrawal skalar Σwallet ${sumWdScalar} != detail transfers ${detailOut}`);

  // 9: Σ transfer internal ≈ 0 — pasangan matched saling meniadakan; sisi
  // sebelah (unmatched) merusaknya, dan memang itu gunanya.
  const internalCandidatesSigned = r9(
    unmatched.filter((t) => own.has(t.counterparty)).reduce((s, t) => s + (t.dir === "in" ? t.amount_sol : -t.amount_sol), 0),
  );
  if (!eq(internalCandidatesSigned, 0, driftTol)) {
    note(`9:Σ transfer internal ${internalCandidatesSigned} != 0 — ${unmatched.length} sisi tak berpasangan (unmatched_internal)`);
  }

  const record = {
    id,
    kind,
    scope: "GROUP",
    group_name: registry.group_name ?? null,
    primary: registry.primary,
    from: isoZ(from),
    to: isoZ(to),
    pnl: {
      fee_lp_sol: feeLpSol,
      impermanent_loss_sol: ilSol,
      net_revenue_sol: netRevenueSol,
      exec_cost_sol: execCost,
      exec_cost_measured_sol: r9(S.liqGap),
      gas_fee_sol: gasFeeSol,
      gross_rill_sol: grossRill,
      llm_cost_sol: llmSol,
      llm_cost_usd: llmUsd,
      net_rill_sol: netRill,
      closes: S.closes,
      wins: S.wins,
    },
    equity: {
      saldo_awal_sol: saldoAwal,
      deposit_sol: depositSol,
      withdrawal_sol: withdrawalSol,
      internal_eliminated_sol: internalEliminatedSol,
      modal_dasar_sol: modalDasar,
      saldo_bebas_sol: saldoBebas,
      modal_posisi_sol: modalPosisi,
      modal_posisi_rent_sol: rentSol,
      total_ekuitas_sol: totalEkuitas,
      laba_kumulatif_sol: labaKumulatif,
      unrealized_pnl_sol: unrealized,
      unrealized_suspect: unrealSuspect,
    },
    roi: {
      dietz_pct: dietzBase > 1e-9 ? Math.round((netRill / dietzBase) * 10000) / 100 : null,
      twr_pct: Math.round((twrFactor - 1) * 10000) / 100,
    },
    wallets: walletRows,
    internal_transfers: [...elim.internal, ...joinFunding],
    unmatched_internal: unmatched.map((t) => ({
      sig: t.sig, ts: t.ts, dir: t.dir, wallet_id: t.wallet_id, counterparty: t.counterparty, amount_sol: t.amount_sol,
    })),
    joining_capital: joinings.map(({ wallet_id, ts, snapshot_id, amount_sol, remaining }) => ({
      wallet_id, ts, snapshot_id, amount_sol, counted_sol: r9(remaining),
    })),
    retiring_capital: retirings.map(({ wallet_id, ts, snapshot_id, amount_sol }) => ({ wallet_id, ts, snapshot_id, amount_sol })),
    llm_shared_keys: llm.sharedKeys,
    integrity: {
      windows: completeWindows,
      windows_expected: expectedWindows,
      complete,
      wallets_missing: [...walletsMissing],
      all_trusted: perWallet.every((p) => p.fold.win.length === 0 || p.fold.allTrusted),
      cum_drift_sol: r9(perWallet.reduce((s, p) => s + p.fold.cumDrift, 0)),
      integrity_ok: true, // difinalkan di bawah
      assertions_failed: assertions,
    },
    sol_price_close: solPriceClose,
    price_skew_pct: priceSkewPct,
  };
  if (isYtd) record.as_of = new Date(now).toISOString();
  else record.generated_at = new Date(now).toISOString();
  record.integrity.integrity_ok = assertions.length === 0;
  return record;
}
