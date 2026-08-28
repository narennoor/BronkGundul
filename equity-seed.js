// equity-seed.js — pengisian sejarah ledger, ONE-SHOT (fase 6, §13).
//
// Satu walk penuh SEKALI per wallet untuk menetapkan anchor pertama, lalu
// menulis seal pembuka. Setelah ini jalur walk-penuh tidak pernah dipakai
// lagi oleh kode laporan mana pun — snapshot harian berjalan inkremental
// (equity-snapshot.js) dan semua laporan adalah aritmetika berkas lokal.
//
// HARD RULES:
//   - Modul ini TIDAK BOLEH di-import oleh kode laporan mana pun
//     (financial-report.js / financial-csv.js / consolidate.js /
//     equity-snapshot.js). Satu-satunya pemanggil yang sah adalah
//     scripts/seed-equity-ledger.mjs dan unit test-nya.
//   - Jalankan dengan daemon DIPAUSE: telescoping saldo dianggap eksak hanya
//     kalau wallet tidak bergerak selama walk — dijaga dengan membaca balance
//     dua kali (sebelum + sesudah walk) dan ABORT bila bergeser.
//
// Model kepercayaan entri seeded (source: "seeded"):
//   saldo(boundary) = balance_sekarang − Σ walletChange(tx setelah boundary)
//   — trik applyCutoff per boundary. Eksak bila (a) walk mencapai cutoff
//   (reachedCutoff), (b) balance stabil selama walk, dan (c) bila ledger
//   sudah punya entri terukur (genesis 27 Agu), saldo turunan walk WAJIB
//   cocok dengannya — dua anchor independen yang memvalidasi seluruh
//   telescoping di antaranya. Gagal salah satu ⇒ ABORT, tidak menulis apa pun.
//   delta_balance/drift per window sengaja null: keduanya tautologis pada
//   saldo turunan (dua sisi dari data yang sama), kepercayaannya datang dari
//   anchor, bukan dari cek per-window.
//
// Batas presisi yang DIKETAHUI dan dilaporkan, bukan disembunyikan:
//   - modal_posisi historis direkonstruksi dari buku (state.json interval
//     deployed/closed yang eksak + entri performance/archive lewat
//     [recorded_at − minutes_held, recorded_at)); rent historis tak
//     terpulihkan → 0. market_memo suspect, harga SOL & LLM lifetime
//     historis null (SOL-native, konsisten dengan entri derived §11).

import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { readJsonStore, writeJsonAtomic } from "./utils/json-store.js";
import { walletChange, fetchAllTxs, fetchBalance } from "./utils/chain-flows.js";
import {
  loadSnapshots,
  loadPeriods,
  sealPeriod,
  takeSnapshot,
  buildWindowSnapshot,
  dayBoundaryUtc,
  snapshotIdFor,
  resolveLedgerDir,
  ledgerWalletAddress,
  readPerformanceEntries,
  periodBounds,
  periodIdFor,
  prevPeriodId,
} from "./equity-snapshot.js";

const DAY_MS = 24 * 3600 * 1000;
const round9 = (v) => Math.round(v * 1e9) / 1e9;

// Filter recorded_at yang identik dengan bookEntriesIn (equity-snapshot.js) —
// baris book entri seeded harus cocok dengan jalur snapshot normal.
function bookIn(perf, fromMs, toMs) {
  return perf.filter((e) => {
    const at = Date.parse(e.recorded_at);
    return Number.isFinite(at) && at >= fromMs && at < toMs;
  });
}

/**
 * Principal posisi terbuka pada satu boundary, direkonstruksi dari buku:
 * posisi state.json membawa interval deployed_at/closed_at yang EKSAK
 * (termasuk yang masih terbuka — closed_at null = sampai sekarang); entri
 * performance/performance_archive yang posisinya sudah tidak ada di state
 * diperkirakan lewat [recorded_at − minutes_held, recorded_at). Dedup lewat
 * field `position` supaya satu posisi tidak dihitung dua kali.
 */
export function buildPrincipalIndex() {
  const intervals = [];
  const seen = new Set();
  const state = readJsonStore(repoPath("state.json"), { positions: {} });
  for (const p of Object.values(state.positions || {})) {
    if (p.dry) continue;
    const dep = Date.parse(p.deployed_at);
    if (!Number.isFinite(dep)) continue;
    const closed = p.closed ? Date.parse(p.closed_at) : Infinity;
    intervals.push({ from: dep, to: Number.isFinite(closed) ? closed : Infinity, sol: p.amount_sol || 0 });
    if (p.position) seen.add(p.position);
  }
  for (const e of readPerformanceEntries()) {
    if (e.position && seen.has(e.position)) continue;
    const closed = Date.parse(e.closed_at ?? e.recorded_at);
    const mins = Number(e.minutes_held);
    if (!Number.isFinite(closed) || !Number.isFinite(mins) || mins < 0) continue;
    intervals.push({ from: closed - mins * 60e3, to: closed, sol: e.amount_sol || 0 });
  }
  return (boundaryMs) =>
    round9(intervals.reduce((s, iv) => s + (iv.from <= boundaryMs && boundaryMs < iv.to ? iv.sol : 0), 0));
}

/**
 * Segel semua periode yang sudah tutup dan TERCAKUP penuh oleh ledger sejak
 * `fromMs` — kronologis per kind supaya rantai assertion 7 terhubung. Periode
 * yang mulai sebelum fromMs (minggu/bulan parsial di awal sejarah) dilewati
 * selamanya: boundary pembukanya memang tidak ada, dan rantai kind itu
 * dimulai dari periode penuh pertama ("seal pembuka"). Idempoten: seal yang
 * sudah ada dilewati, tidak pernah ditimpa.
 */
export function sealClosedPeriodsFrom(fromMs, now = Date.now()) {
  const sealed = [];
  const skipped = [];
  for (const kind of ["week", "month", "year"]) {
    let id = periodIdFor(kind, fromMs);
    if (periodBounds(kind, id).from < fromMs) id = periodIdFor(kind, periodBounds(kind, id).to);
    while (periodBounds(kind, id).to <= now) {
      try {
        const rec = sealPeriod(kind, id, { now });
        sealed.push({ kind, id, integrity_ok: rec.integrity.integrity_ok, net_rill_sol: rec.pnl.net_rill_sol });
      } catch (e) {
        if (/sudah ada/.test(e.message)) skipped.push(`${kind} ${id} sudah tersegel`);
        else throw new Error(`Seal ${kind} ${id} gagal: ${e.message}`);
      }
      id = periodIdFor(kind, periodBounds(kind, id).to);
    }
  }
  return { sealed, skipped };
}

/**
 * Verifikasi kriteria fase 6: rantai seal per kind tersambung tanpa putus —
 * setiap seal berantai ke pendahulunya yang persis sebelumnya, saldo_awal[N]
 * == total_ekuitas[N−1], dan tidak ada assertion 7 yang gagal di seal mana
 * pun. Murni baca berkas — nol network.
 */
export function verifySealChain(wallet = ledgerWalletAddress()) {
  const periods = loadPeriods(wallet).periods;
  const problems = [];
  const counts = {};
  for (const kind of ["week", "month", "year"]) {
    const seals = periods.filter((p) => p.kind === kind).sort((a, b) => (a.from < b.from ? -1 : 1));
    counts[kind] = seals.length;
    for (let i = 0; i < seals.length; i++) {
      const s = seals[i];
      for (const a of s.integrity.assertions_failed) {
        if (a.startsWith("7:")) problems.push(`${kind} ${s.id}: ${a}`);
      }
      if (i > 0) {
        const prev = seals[i - 1];
        if (prevPeriodId(kind, s.id) !== prev.id) {
          problems.push(`${kind} ${s.id}: rantai bolong — seal sebelumnya ${prev.id}, harusnya ${prevPeriodId(kind, s.id)}`);
        } else if (Math.abs(s.equity.saldo_awal_sol - prev.equity.total_ekuitas_sol) > 1e-9) {
          problems.push(
            `${kind} ${s.id}: saldo_awal ${s.equity.saldo_awal_sol} != total_ekuitas ${prev.id} (${prev.equity.total_ekuitas_sol})`,
          );
        }
      }
    }
  }
  return { wallet, counts, problems, ok: problems.length === 0 };
}

/**
 * Isi sejarah ledger wallet env dari `from` (YYYY-MM-DD) sampai kemarin,
 * lalu ambil snapshot hari ini lewat jalur inkremental normal, segel periode
 * tertutup, dan verifikasi rantainya.
 *
 * Idempoten: ledger yang sudah mencakup `from` melewati walk SELURUHNYA
 * (nol Helius) dan langsung lanjut ke seal + verifikasi — rerun setelah seal
 * gagal separuh aman. Entri yang sudah ada tidak pernah diubah, KECUALI
 * placeholder genesis (flows kosong, txs 0): window-nya diisi dari walk
 * sementara seluruh angka ekuitas terukurnya dipertahankan — setelah saldo
 * turunannya terbukti cocok.
 */
export async function seedLedger({ from, now = Date.now(), dryRun = false, maxPages = 400 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
    throw new Error(`--from wajib YYYY-MM-DD, dapat "${from}"`);
  }
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const todayBoundary = dayBoundaryUtc(now);
  if (!(fromMs < todayBoundary)) throw new Error(`--from ${from} harus sebelum hari ini (UTC)`);

  const wallet = ledgerWalletAddress();
  const store = loadSnapshots(wallet);
  const existing = new Map(store.snapshots.map((s) => [Date.parse(s.boundary_ts), s]));
  const firstExisting = store.snapshots.length ? Date.parse(store.snapshots[0].boundary_ts) : null;

  const summary = { wallet, from, walked: false, written: [], merged: [], validated: [], sealed: [], skippedSeals: [], today: null, chain: null };

  if (firstExisting != null && firstExisting <= fromMs) {
    log("seed", `Ledger ${wallet.slice(0, 4)}… sudah mencakup ${from} (mulai ${store.snapshots[0].id}) — lewati walk, lanjut seal + verifikasi`);
  } else {
    if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not set");
    if (!process.env.RPC_URL) throw new Error("RPC_URL not set");
    const overlapSec = Math.max(0, Number(config.report.walkOverlapMin ?? 30)) * 60;
    const driftTol = Number(config.report.driftToleranceSol ?? 0.001);

    // ── walk penuh SEKALI: balance → walk → balance (bukti stabilitas) ──
    const balanceBefore = await fetchBalance(wallet);
    const walk = await fetchAllTxs(wallet, process.env.HELIUS_API_KEY, {
      stopBeforeSec: Math.floor(fromMs / 1000) - overlapSec,
      maxPages,
    });
    const balanceNow = await fetchBalance(wallet);
    summary.walked = true;
    summary.txs = walk.txs.length;
    if (!walk.reachedCutoff) {
      throw new Error(
        `Walk tidak mencapai cutoff ${from} setelah ${walk.txs.length} tx (maxPages=${maxPages}) — ` +
        `tidak menulis apa pun; naikkan --max-pages atau majukan --from`,
      );
    }
    if (Math.abs(balanceNow - balanceBefore) > 1e-9) {
      throw new Error(
        `Balance bergeser selama walk (${balanceBefore} → ${balanceNow} SOL) — daemon belum dipause? Tidak menulis apa pun`,
      );
    }

    // ── telescoping + validasi terhadap SEMUA entri terukur yang ada ──
    const saldoAt = (b) =>
      round9(balanceNow - walk.txs.filter((t) => t.timestamp >= b / 1000).reduce((s, t) => s + walletChange(t, wallet), 0));
    for (const [b, entry] of existing) {
      if (b < fromMs) continue;
      const derived = saldoAt(b);
      const recorded = entry.equity.saldo_bebas_sol;
      if (Math.abs(derived - recorded) > driftTol) {
        throw new Error(
          `Anchor tidak cocok di ${entry.id}: saldo turunan walk ${derived} vs terukur ${recorded} ` +
          `(selisih ${round9(derived - recorded)} > ${driftTol}) — tidak menulis apa pun`,
        );
      }
      summary.validated.push({ id: entry.id, derived, recorded });
    }

    // ── rakit entri [from .. kemarin] ──
    const perf = readPerformanceEntries();
    const principalAt = buildPrincipalIndex();
    const takenAtIso = new Date(now).toISOString();
    const common = {
      wallet,
      takenAtIso,
      driftToleranceSol: driftTol,
      overlapSec,
      llmKeyIdVal: null, // pembacaan lifetime historis tak terpulihkan
      solPrice: null, // harga historis tak terpulihkan — SOL-native (§11)
      llmUsdLifetime: null,
      marketMemo: { nilai_pasar_sol: null, suspect: true },
      prevSaldoBebasSol: null, // delta/drift tautologis pada saldo turunan — kepercayaan dari anchor
      walkReachedCutoff: true,
      trustedOverride: true, // reachedCutoff + balance stabil + anchor cocok (lihat header)
    };
    const newEntries = [];
    for (let b = fromMs; b < todayBoundary; b += DAY_MS) {
      const principal = principalAt(b);
      const positions = principal > 0 ? [{ amount_sol: principal }] : []; // buildWindowSnapshot menjumlahkan amount_sol
      // Entri pertama = anchor pembuka tanpa window (pola genesis); sisanya
      // window penuh [b−1hari, b) dari data walk.
      const windowTxs =
        b === fromMs ? [] : walk.txs.filter((t) => t.timestamp >= (b - DAY_MS) / 1000 && t.timestamp < b / 1000);
      const entry = buildWindowSnapshot({
        ...common,
        id: snapshotIdFor(b),
        boundaryMs: b,
        source: "seeded",
        windowTxs,
        saldoBebasSol: saldoAt(b),
        positions,
        rentSol: 0, // rent historis tak terpulihkan (akun posisi sudah tutup)
        bookEntries: b === fromMs ? [] : bookIn(perf, b - DAY_MS, b),
      });
      const prior = existing.get(b);
      if (!prior) {
        newEntries.push(entry);
        summary.written.push(entry.id);
      } else if (prior.source === "genesis" && (prior.integrity?.txs ?? 0) === 0) {
        // Placeholder genesis: isi window-nya, pertahankan angka terukurnya.
        prior.flows = entry.flows;
        prior.book = entry.book;
        prior.window_sigs = entry.window_sigs;
        prior.integrity = { ...entry.integrity, trusted: true };
        summary.merged.push(prior.id);
      } // entri lain (light/derived) sudah benar dari jalur inkremental — jangan disentuh
    }

    if (dryRun) {
      summary.dryRun = true;
      log("seed", `DRY-RUN ${wallet.slice(0, 4)}…: ${summary.written.length} entri akan ditulis, ${summary.merged.length} genesis di-merge, ${summary.validated.length} anchor tervalidasi — tidak ada yang ditulis`);
      return summary;
    }

    store.snapshots.push(...newEntries);
    store.snapshots.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const file = path.join(resolveLedgerDir(), wallet, "snapshots.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, store);
    log("seed", `Seed ${wallet.slice(0, 4)}…: ${summary.written.length} entri seeded (${from} → ${snapshotIdFor(todayBoundary - DAY_MS)}), ${summary.merged.length} genesis di-merge, ${walk.txs.length} tx`);
  }

  if (!dryRun) {
    // Snapshot hari ini lewat jalur inkremental NORMAL (harga/LLM/rent live) —
    // idempoten bila sudah ada. Walk-nya kecil: anchor = entri kemarin.
    const today = await takeSnapshot({ now });
    summary.today = today.skipped ?? today.written;

    const seals = sealClosedPeriodsFrom(fromMs, now);
    summary.sealed = seals.sealed;
    summary.skippedSeals = seals.skipped;
  }

  summary.chain = verifySealChain(wallet);
  return summary;
}
