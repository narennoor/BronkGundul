// Fase 5 — konsolidasi multi-wallet (ledger-registry.js, ledger-transport.js,
// consolidate.js, financial-csv.js grup).
//
// Mandated by the design (§10):
//   (a) diperluas ke jalur grup: ledger palsu ±90 hari untuk 2 wallet, laporan
//       bulanan GRUP, dan fetch stub yang THROWS — suite ini berakhir dengan
//       assert(fetchCalls === 0),
//   (b) eliminasi transfer internal: dipasangkan lewat SIGNATURE; transfer 2
//       SOL antar wallet menghasilkan deposit/withdrawal grup 0; sisi sebelah
//       masuk unmatched_internal[] dan tetap flow eksternal (assertion 9
//       melabel); GAS transfer internal TIDAK dieliminasi,
//   (c) dedup LLM key bersama: satu key = satu biaya, kolom wallet = "shared",
//   (e) wallet bergabung di tengah: modal awal = setoran grup, dikurangi
//       bagian yang datang dari wallet sendiri (join_funding),
//   plus kelengkapan §08 (complete/wallets_missing), harga primary + skew,
//   dan dua lane assertion 8 (skalar snapshot vs detail transfers[]).
//
// Semua tanggal sintetis dan dipin — suite tidak pernah menua.

import { ledgerPath, REGISTRY_PATH } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

process.env.RPC_URL = "http://unit-test.invalid/rpc";
process.env.HELIUS_API_KEY = "unit-test-helius-key";
process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";

// Seluruh jalur konsolidasi tidak boleh menyentuh network (aturan nol-walk).
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls++;
  throw new Error(`zero-walk violated: fetch(${String(url).slice(0, 80)})`);
};

const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const kp = (id) => {
  const k = Keypair.generate();
  return { id, address: k.publicKey.toString(), secret: bs58.encode(k.secretKey) };
};
const A = kp("CopetT"); // primary dataset 1
const B = kp("BronkT");
const C = kp("CWal");
const D = kp("DWal");
const E = kp("EWal");
const F = kp("FWal");
const G = kp("GWal");
const H = kp("HWal");
const I = kp("IWal");
const J = kp("JWal");
process.env.WALLET_PRIVATE_KEY = A.secret; // "daemon" suite = wallet A

const { consolidatePeriod, eliminateInternalTransfers, dedupLlmCost } = await import("../consolidate.js");
const { loadRegistry, activeWalletsAt, walletsActiveIn, isOwnWallet, resolveRegistryPath } =
  await import("../ledger-registry.js");
const { readLedger } = await import("../ledger-transport.js");
const { snapshotIdFor, isoWeekIdFor, computePeriodRecord } = await import("../equity-snapshot.js");
const { formatFinancialReport } = await import("../financial-report.js");
const { buildGroupReportCsvs, PERIODS_CSV_COLUMNS, CURVE_CSV_COLUMNS } = await import("../financial-csv.js");
const { writeJsonAtomic } = await import("../utils/json-store.js");

const DAY = 24 * 3600 * 1000;
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const isoZ = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const noonSec = (dayId) => (Date.parse(`${dayId}T00:00:00Z`) + 12 * 3600 * 1000) / 1000;

const START = Date.parse("2026-06-01T00:00:00Z");
const END = Date.parse("2026-09-01T00:00:00Z"); // 92 window — ≥90 hari, 2 wallet
const AUG_FROM = Date.parse("2026-08-01T00:00:00Z");

// ── generator ledger sintetis, hand-computable ───────────────────────
// Tiap window (non-genesis): gas 0.001, book net_revenue 0.002, fee_lp 0.003
// → akresi saldo +0.001/hari/wallet. events[windowDayId].transfers menggeser
// saldo dan tercatat di flows.transfers[] persis seperti classifyCashFlows.
function makeSnapshots({ start, end, saldo0, price, llmKey, llm0, llmStep, events = {}, skipIds = [] }) {
  const snapshots = [];
  let saldo = saldo0;
  let i = 0;
  for (let b = start; b <= end; b += DAY, i++) {
    const id = snapshotIdFor(b);
    const first = b === start;
    const windowDay = snapshotIdFor(b - DAY);
    const transfers = first ? [] : (events[windowDay]?.transfers ?? []);
    const dep = r9(transfers.filter((t) => t.dir === "in").reduce((s, t) => s + t.amount_sol, 0));
    const wd = r9(transfers.filter((t) => t.dir === "out").reduce((s, t) => s + t.amount_sol, 0));
    const gas = first ? 0 : 0.001;
    const bookNet = first ? 0 : 0.002;
    const flowSum = first ? 0 : r9(dep - wd - gas + bookNet);
    saldo = r9(saldo + flowSum);
    if (skipIds.includes(id)) continue; // hari bolong (daemon mati) — saldo tetap jalan
    snapshots.push({
      id,
      boundary_ts: isoZ(b),
      taken_at: new Date(b + 5 * 60 * 1000).toISOString(),
      source: first ? "genesis" : "light",
      equity: { saldo_bebas_sol: saldo, modal_posisi_sol: 0, principal_sol: 0, rent_sol: 0, total_sol: saldo },
      market_memo: { nilai_pasar_sol: 0, suspect: false },
      flows: {
        deposit_in_sol: dep,
        withdraw_out_sol: wd,
        gas_sol: gas,
        gas_txn: first ? 0 : 2,
        transfers: transfers.map((t) => ({ sig: t.sig, ts: t.ts ?? noonSec(windowDay), dir: t.dir, counterparty: t.counterparty, amount_sol: t.amount_sol })),
      },
      book: { closed: first ? 0 : 1, wins: first ? 0 : 1, fee_lp_sol: first ? 0 : 0.003, net_revenue_sol: bookNet, liquidation_gap_sol: 0 },
      sol_price: price,
      llm_usd_lifetime: llmKey ? r9(llm0 + llmStep * i) : null,
      llm_key_id: llmKey,
      integrity: { delta_balance_sol: first ? null : flowSum, flow_sum_sol: flowSum, drift_sol: first ? null : 0, trusted: true, txs: 2 },
      window_sigs: [],
    });
  }
  return snapshots;
}

function writeLedger(w, snapshots, periods = []) {
  fs.mkdirSync(ledgerPath(w.address), { recursive: true });
  writeJsonAtomic(ledgerPath(w.address, "snapshots.json"), { version: 1, address: w.address, snapshots });
  if (periods.length) {
    writeJsonAtomic(ledgerPath(w.address, "periods.json"), { version: 1, address: w.address, periods });
  }
}

const regEntry = (w, active_from, active_to = null) => ({
  id: w.id,
  address: w.address,
  label: w.id,
  transport: { kind: "fs" }, // path default: <MERIDIAN_LEDGER_DIR>/<address>
  active_from,
  active_to,
});

// ── dataset 1: dua wallet penuh Juni–September, INT1 2 SOL A→B ───────
const reg1 = {
  version: 1,
  group_name: "Gundul Test",
  primary: A.id,
  wallets: [regEntry(A, "2026-06-01"), regEntry(B, "2026-06-01")],
};
writeLedger(A, makeSnapshots({
  start: START, end: END, saldo0: 10, price: 200, llmKey: "keyAAAA", llm0: 10, llmStep: 0.05,
  events: {
    "2026-08-05": { transfers: [{ sig: "EXT1", dir: "in", counterparty: "EXTERNAL11111111111111111111111111111111111", amount_sol: 3 }] },
    "2026-08-10": { transfers: [{ sig: "INT1", dir: "out", counterparty: B.address, amount_sol: 2 }] },
  },
}));
writeLedger(B, makeSnapshots({
  start: START, end: END, saldo0: 8, price: 201, llmKey: "keyBBBB", llm0: 5, llmStep: 0.02,
  events: {
    "2026-08-10": { transfers: [{ sig: "INT1", dir: "in", counterparty: A.address, amount_sol: 2 }] },
  },
}));

// ── registry murni ───────────────────────────────────────────────────

test("registry: path isolasi test + validasi bentuk", () => {
  assert.equal(resolveRegistryPath(), REGISTRY_PATH);
  assert.throws(() => loadRegistry(), /belum ada/); // file belum ditulis
  writeJsonAtomic(REGISTRY_PATH, { version: 1, primary: "X", wallets: [regEntry(A, "2026-06-01")] });
  assert.throws(() => loadRegistry(), /primary "X" tidak ada/);
  writeJsonAtomic(REGISTRY_PATH, {
    version: 1, primary: A.id,
    wallets: [regEntry(A, "2026-06-01"), { ...regEntry(B, "2026-06-01"), id: A.id }],
  });
  assert.throws(() => loadRegistry(), /ganda/);
  writeJsonAtomic(REGISTRY_PATH, reg1); // registry sah — dipakai test CSV di bawah
  assert.equal(loadRegistry().primary, A.id);
});

test("registry: activeWalletsAt / walletsActiveIn / isOwnWallet", () => {
  const reg = {
    version: 1, primary: A.id,
    wallets: [regEntry(A, "2026-06-01"), regEntry(B, "2026-08-11", "2026-09-15")],
  };
  assert.deepEqual(activeWalletsAt(Date.parse("2026-07-01T00:00:00Z"), reg).map((w) => w.id), [A.id]);
  assert.deepEqual(activeWalletsAt(Date.parse("2026-08-11T00:00:00Z"), reg).map((w) => w.id), [A.id, B.id]);
  // active_to inklusif: 15 Sep masih aktif, 16 Sep tidak
  assert.deepEqual(activeWalletsAt(Date.parse("2026-09-15T12:00:00Z"), reg).map((w) => w.id), [A.id, B.id]);
  assert.deepEqual(activeWalletsAt(Date.parse("2026-09-16T00:00:00Z"), reg).map((w) => w.id), [A.id]);
  // overlap periode
  assert.deepEqual(
    walletsActiveIn(Date.parse("2026-07-01T00:00:00Z"), Date.parse("2026-08-01T00:00:00Z"), reg).map((w) => w.id),
    [A.id],
  );
  assert.ok(isOwnWallet(B.address, reg));
  assert.ok(!isOwnWallet("EXTERNAL11111111111111111111111111111111111", reg));
});

test("transport: fs default path + kind lain throw", () => {
  const led = readLedger(regEntry(A, "2026-06-01"));
  assert.equal(led.snapshots.length, 93); // 1 Jun – 1 Sep inklusif
  assert.throws(() => readLedger({ ...regEntry(A, "2026-06-01"), transport: { kind: "https", url: "x" } }), /belum diimplementasikan/);
  // ledger belum ada → kosong, bukan error (wallets_missing yang melaporkan)
  const empty = readLedger(regEntry(kp("KosongT"), "2026-06-01"));
  assert.deepEqual(empty.snapshots, []);
  assert.deepEqual(empty.periods, []);
});

// ── eliminasi murni ──────────────────────────────────────────────────

test("eliminateInternalTransfers: pasangan by signature, bukan jumlah+waktu", () => {
  const own = new Set([A.address, B.address]);
  const ts = noonSec("2026-08-10");
  const transfers = [
    { sig: "S1", ts, dir: "out", counterparty: B.address, amount_sol: 2, wallet_id: A.id, wallet_address: A.address },
    { sig: "S1", ts, dir: "in", counterparty: A.address, amount_sol: 2, wallet_id: B.id, wallet_address: B.address },
    // jumlah & waktu SAMA tapi sig beda → bukan pasangan
    { sig: "S2", ts, dir: "out", counterparty: B.address, amount_sol: 2, wallet_id: A.id, wallet_address: A.address },
    // eksternal — tidak disentuh
    { sig: "S3", ts, dir: "in", counterparty: "EXT", amount_sol: 5, wallet_id: A.id, wallet_address: A.address },
  ];
  const res = eliminateInternalTransfers(transfers, own);
  assert.equal(res.internal.length, 1);
  assert.deepEqual(
    { sig: res.internal[0].sig, from: res.internal[0].from_wallet, to: res.internal[0].to_wallet },
    { sig: "S1", from: A.id, to: B.id },
  );
  assert.equal(res.unmatched.length, 1);
  assert.equal(res.unmatched[0].sig, "S2");
  assert.equal(res.external.length, 1);
  assert.equal(res.external[0].sig, "S3");
});

test("dedupLlmCost: key beda = alokasi eksak; key sama = sekali + shared", () => {
  const snap = (key, usd) => ({ llm_key_id: key, llm_usd_lifetime: usd });
  const distinct = dedupLlmCost([
    { wallet_id: "W1", opening: snap("k1", 10), closing: snap("k1", 13) },
    { wallet_id: "W2", opening: snap("k2", 5), closing: snap("k2", 7) },
  ]);
  close(distinct.totalUsd, -5);
  close(distinct.perWallet.W1, -3);
  close(distinct.perWallet.W2, -2);
  assert.deepEqual(distinct.sharedKeys, []);
  const shared = dedupLlmCost([
    { wallet_id: "W1", opening: snap("kS", 10), closing: snap("kS", 13) },
    { wallet_id: "W2", opening: snap("kS", 10.1), closing: snap("kS", 13.05) },
  ]);
  close(shared.totalUsd, -3); // pembacaan terlebar, SEKALI — bukan −5.95
  assert.equal(shared.perWallet.W1, "shared");
  assert.equal(shared.perWallet.W2, "shared");
  assert.deepEqual(shared.sharedKeys, ["kS"]);
});

// ── (b) laporan bulanan grup, dataset 1 ──────────────────────────────

test("konsolidasi bulanan: eliminasi INT1, gas tetap, LLM eksak, harga primary", () => {
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: reg1, now: Date.parse("2026-09-01T00:30:00Z") });
  assert.equal(rec.scope, "GROUP");
  assert.equal(rec.primary, A.id);

  // eliminasi: hanya EXT1 yang tersisa sebagai flow grup
  assert.equal(rec.internal_transfers.length, 1);
  assert.equal(rec.internal_transfers[0].sig, "INT1");
  assert.deepEqual(rec.unmatched_internal, []);
  close(rec.equity.internal_eliminated_sol, 2);
  close(rec.equity.deposit_sol, 3);
  close(rec.equity.withdrawal_sol, 0);

  // gas transfer internal TIDAK dieliminasi: 31 hari × 0.001 × 2 wallet
  close(rec.pnl.gas_fee_sol, -0.062);

  // identitas ekuitas, hand-computed: akresi +0.001/hari/wallet
  const aOpen = 10 + 61 * 0.001; // 61 window: 2 Jun – 1 Agu
  const bOpen = 8 + 61 * 0.001;
  close(rec.equity.saldo_awal_sol, r9(aOpen + bOpen));
  close(rec.pnl.gross_rill_sol, 0.062); // 31×0.001×2 — transfer internal tidak menggeser gross
  close(rec.equity.total_ekuitas_sol, r9(aOpen + bOpen + 3 + 0.062));
  close(rec.pnl.net_revenue_sol, 0.124);
  close(rec.pnl.fee_lp_sol, 0.186);
  close(rec.pnl.impermanent_loss_sol, -0.062);
  close(rec.pnl.exec_cost_sol, 0);
  assert.equal(rec.pnl.closes, 62);

  // LLM: key beda → eksak per wallet, grup = jumlah
  close(rec.pnl.llm_cost_usd, -2.17); // 31×0.05 + 31×0.02
  const wA = rec.wallets.find((w) => w.wallet_id === A.id);
  const wB = rec.wallets.find((w) => w.wallet_id === B.id);
  close(wA.llm_cost_usd, -1.55);
  close(wB.llm_cost_usd, -0.62);

  // §08: satu harga per boundary — dari primary; skew 0.5% di bawah ambang
  assert.equal(rec.sol_price_close, 200);
  assert.equal(rec.price_skew_pct, null);

  // kelengkapan + integritas
  assert.equal(rec.integrity.complete, true);
  assert.deepEqual(rec.integrity.wallets_missing, []);
  assert.equal(rec.integrity.windows, 31);
  assert.equal(rec.integrity.windows_expected, 31);
  assert.deepEqual(rec.integrity.assertions_failed, []);
  assert.equal(rec.integrity.integrity_ok, true);

  // assertion 8: Σ wallet == GROUP (lane fold per-wallet — belum ada seal)
  close(r9(wA.gross_rill_sol + wB.gross_rill_sol), rec.pnl.gross_rill_sol);
  assert.equal(typeof rec.roi.twr_pct, "number");
  assert.equal(typeof rec.roi.dietz_pct, "number");
});

test("SELESAI-KALAU: transfer internal 2 SOL → deposit_net grup 0 (minggu INT1)", () => {
  const weekId = isoWeekIdFor(Date.parse("2026-08-10T12:00:00Z")); // minggu Senin 10 Agu
  const rec = consolidatePeriod({ kind: "week", id: weekId, registry: reg1, now: Date.parse("2026-09-01T00:30:00Z") });
  close(rec.equity.deposit_sol, 0);
  close(rec.equity.withdrawal_sol, 0);
  close(rec.equity.internal_eliminated_sol, 2);
  assert.equal(rec.integrity.integrity_ok, true);
  // modal dasar grup tidak menggelembung → saldo_awal == modal_dasar
  close(rec.equity.modal_dasar_sol, rec.equity.saldo_awal_sol);
});

test("konsolidasi YTD: as_of, tanpa sealed_at, wallet masuk sebagai setoran", () => {
  const rec = consolidatePeriod({ kind: "ytd", id: "2026", registry: reg1, now: Date.parse("2026-09-01T10:00:00Z") });
  assert.equal(rec.kind, "ytd");
  assert.equal(rec.id, "2026-YTD");
  assert.ok(rec.as_of);
  assert.equal(rec.sealed_at, undefined);
  // ledger mulai Juni: kedua wallet bergabung di tengah tahun → saldo_awal 0,
  // modal awal masuk sebagai setoran grup (§08)
  close(rec.equity.saldo_awal_sol, 0);
  assert.equal(rec.joining_capital.length, 2);
  close(rec.equity.deposit_sol, r9(10 + 8 + 3)); // genesis A + genesis B + EXT1
  close(rec.equity.internal_eliminated_sol, 2); // INT1 tetap tereliminasi
  assert.equal(rec.integrity.integrity_ok, true);
});

// ── unmatched: daemon mati saat transfer (assertion 9 + kelengkapan) ─

test("sisi tak berpasangan → unmatched_internal, flow eksternal, assertion 9", () => {
  const regCD = { version: 1, group_name: "CD", primary: C.id, wallets: [regEntry(C, "2026-06-01"), regEntry(D, "2026-06-01")] };
  writeLedger(C, makeSnapshots({
    start: START, end: END, saldo0: 6, price: 200, llmKey: "keyCCCC", llm0: 1, llmStep: 0.01,
    events: { "2026-08-20": { transfers: [{ sig: "INT9", dir: "out", counterparty: D.address, amount_sol: 1 }] } },
  }));
  // D mati 21 Agu: snapshot boundary 2026-08-21 (window 20 Agu) hilang —
  // sisi masuk INT9 tidak pernah tercatat
  writeLedger(D, makeSnapshots({
    start: START, end: END, saldo0: 4, price: 200, llmKey: "keyDDDD", llm0: 1, llmStep: 0.01,
    skipIds: ["2026-08-21"],
  }));
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: regCD, now: Date.parse("2026-09-01T00:30:00Z") });
  assert.equal(rec.unmatched_internal.length, 1);
  assert.equal(rec.unmatched_internal[0].sig, "INT9");
  assert.equal(rec.unmatched_internal[0].dir, "out");
  // diperlakukan sebagai flow eksternal — kelihatan, tidak dibuang diam-diam
  close(rec.equity.withdrawal_sol, -1);
  close(rec.equity.internal_eliminated_sol, 0);
  assert.ok(rec.integrity.assertions_failed.some((a) => a.startsWith("9:")), `9 harus gagal: ${rec.integrity.assertions_failed}`);
  assert.equal(rec.integrity.integrity_ok, false);
  // §08: terbit dengan label, bukan menolak terbit
  assert.equal(rec.integrity.complete, false);
  assert.deepEqual(rec.integrity.wallets_missing, [D.id]);
  assert.equal(rec.integrity.windows, 30);
  assert.equal(rec.integrity.windows_expected, 31);
  const wD = rec.wallets.find((w) => w.wallet_id === D.id);
  assert.equal(wD.complete, false);
  assert.equal(wD.missing_dates, 1);
});

// ── (c) key LLM bersama ──────────────────────────────────────────────

test("key OpenRouter sama di dua wallet → biaya sekali, kolom shared", () => {
  const regEF = { version: 1, group_name: "EF", primary: E.id, wallets: [regEntry(E, "2026-06-01"), regEntry(F, "2026-06-01")] };
  writeLedger(E, makeSnapshots({ start: START, end: END, saldo0: 5, price: 200, llmKey: "keySHARE", llm0: 10, llmStep: 0.05 }));
  writeLedger(F, makeSnapshots({ start: START, end: END, saldo0: 5, price: 200, llmKey: "keySHARE", llm0: 10.1, llmStep: 0.03 }));
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: regEF, now: Date.parse("2026-09-01T00:30:00Z") });
  close(rec.pnl.llm_cost_usd, -1.55); // pembacaan terlebar (31×0.05), SEKALI — bukan −2.48
  assert.deepEqual(rec.llm_shared_keys, ["keySHARE"]);
  for (const w of rec.wallets) {
    assert.equal(w.llm_cost_usd, "shared");
    assert.equal(w.llm_cost_sol, "shared");
    close(w.net_rill_sol, w.gross_rill_sol); // tak teratribusi → tidak dibebankan ganda
  }
  assert.equal(rec.integrity.integrity_ok, true); // jaring pengaman, bukan kegagalan
});

// ── (e) wallet bergabung di tengah + join funding ────────────────────

test("mid-join: modal awal = setoran grup, dikurangi dana dari wallet sendiri", () => {
  const regGH = { version: 1, group_name: "GH", primary: G.id, wallets: [regEntry(G, "2026-06-01"), regEntry(H, "2026-08-15")] };
  writeLedger(G, makeSnapshots({
    start: START, end: END, saldo0: 12, price: 200, llmKey: "keyGGGG", llm0: 2, llmStep: 0.01,
    events: { "2026-08-14": { transfers: [{ sig: "FUND1", dir: "out", counterparty: H.address, amount_sol: 2 }] } },
  }));
  // H genesis 15 Agu: total 5.0 — 2 dari G (FUND1), 3 dari luar grup
  writeLedger(H, makeSnapshots({
    start: Date.parse("2026-08-15T00:00:00Z"), end: END, saldo0: 5, price: 200, llmKey: "keyHHHH", llm0: 1, llmStep: 0.01,
  }));
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: regGH, now: Date.parse("2026-09-01T00:30:00Z") });

  assert.equal(rec.joining_capital.length, 1);
  assert.equal(rec.joining_capital[0].wallet_id, H.id);
  close(rec.joining_capital[0].amount_sol, 5);
  close(rec.joining_capital[0].counted_sol, 3); // 2 SOL datang dari G — bukan setoran grup

  const joinFund = rec.internal_transfers.find((t) => t.kind === "join_funding");
  assert.ok(joinFund, "FUND1 harus tereliminasi sebagai join_funding");
  assert.equal(joinFund.sig, "FUND1");
  close(rec.equity.deposit_sol, 3);
  close(rec.equity.withdrawal_sol, 0);
  close(rec.equity.internal_eliminated_sol, 2);
  assert.deepEqual(rec.unmatched_internal, []);

  // saldo awal grup = G saja; gross = akresi G (31) + akresi H (17)
  close(rec.equity.saldo_awal_sol, r9(12 + 61 * 0.001));
  close(rec.pnl.gross_rill_sol, r9(31 * 0.001 + 17 * 0.001));
  assert.equal(rec.integrity.integrity_ok, true, rec.integrity.assertions_failed.join("; "));
  assert.equal(rec.integrity.complete, true); // aktif sejak genesis-nya — tidak ada tanggal bolong
});

// ── assertion 8: skalar snapshot vs detail transfers[] ───────────────

test("skalar deposit yang menyimpang dari transfers[] → assertion 8", () => {
  const regIJ = { version: 1, group_name: "IJ", primary: I.id, wallets: [regEntry(I, "2026-06-01"), regEntry(J, "2026-06-01")] };
  const snapsI = makeSnapshots({
    start: START, end: END, saldo0: 7, price: 200, llmKey: "keyIIII", llm0: 1, llmStep: 0.01,
    events: { "2026-08-10": { transfers: [{ sig: "EXT2", dir: "in", counterparty: "EXTERNAL11111111111111111111111111111111111", amount_sol: 2 }] } },
  });
  // korupsi: skalar bilang 5, detail (dan evolusi saldo) bilang 2
  snapsI.find((s) => s.id === "2026-08-11").flows.deposit_in_sol = 5;
  writeLedger(I, snapsI);
  writeLedger(J, makeSnapshots({ start: START, end: END, saldo0: 3, price: 200, llmKey: "keyJJJJ", llm0: 1, llmStep: 0.01 }));
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: regIJ, now: Date.parse("2026-09-01T00:30:00Z") });
  assert.ok(
    rec.integrity.assertions_failed.some((a) => a.startsWith("8:deposit skalar")),
    `8 harus gagal: ${rec.integrity.assertions_failed}`,
  );
  assert.equal(rec.integrity.integrity_ok, false);
  close(rec.equity.deposit_sol, 2); // grup memercayai detail, bukan skalar
});

test("harga antar wallet menyimpang melewati ambang → price_skew_pct", () => {
  // pakai ledger I/J, harga J diganti via registry berbeda? — harga hidup di
  // snapshot, jadi tulis wallet baru bertarif 250 vs primary 200
  const K = kp("KWal");
  const L = kp("LWal");
  writeLedger(K, makeSnapshots({ start: START, end: END, saldo0: 7, price: 200, llmKey: "keyKKKK", llm0: 1, llmStep: 0.01 }));
  writeLedger(L, makeSnapshots({ start: START, end: END, saldo0: 3, price: 250, llmKey: "keyLLLL", llm0: 1, llmStep: 0.01 }));
  const regKL = { version: 1, group_name: "KL", primary: K.id, wallets: [regEntry(K, "2026-06-01"), regEntry(L, "2026-06-01")] };
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: regKL, now: Date.parse("2026-09-01T00:30:00Z") });
  assert.equal(rec.sol_price_close, 200); // tetap harga primary
  close(rec.price_skew_pct, 25);
});

// ── formatter + CSV grup ─────────────────────────────────────────────

test("formatter grup: blok Per Wallet + baris integritas grup", () => {
  const rec = consolidatePeriod({ kind: "month", id: "2026-08", registry: reg1, now: Date.parse("2026-09-01T00:30:00Z") });
  const txt = formatFinancialReport({ wallet: rec.group_name, record: rec });
  assert.match(txt, /GRUP Gundul Test/);
  assert.match(txt, /PER WALLET/);
  assert.match(txt, /CopetT/);
  assert.match(txt, /BronkT/);
  assert.match(txt, /Transfer internal 2\.0000 SOL dieliminasi/);
  assert.match(txt, /Wallet lengkap: CopetT ✓ · BronkT ✓/);
});

test("CSV grup: baris GROUP dulu, lalu WALLET; internal_eliminated hanya di GROUP", () => {
  // segel Agustus di kedua ledger (computePeriodRecord murni — tanpa network)
  const sealFor = (w) => computePeriodRecord({
    kind: "month", id: "2026-08",
    snapshots: readLedger(regEntry(w, "2026-06-01")).snapshots,
    sealedAtIso: "2026-09-01T00:30:00.000Z",
  });
  writeLedger(A, readLedger(regEntry(A, "2026-06-01")).snapshots, [sealFor(A)]);
  writeLedger(B, readLedger(regEntry(B, "2026-06-01")).snapshots, [sealFor(B)]);

  const groupRec = consolidatePeriod({ kind: "month", id: "2026-08", registry: reg1, now: Date.parse("2026-09-01T00:30:00Z") });
  // wallet rows sekarang datang dari SEAL — lane assertion 8 yang kedua
  assert.equal(groupRec.wallets.every((w) => w.sealed), true);
  assert.equal(groupRec.integrity.integrity_ok, true, groupRec.integrity.assertions_failed.join("; "));

  const files = buildGroupReportCsvs(groupRec); // registry dibaca dari REGISTRY_PATH (reg1)
  assert.deepEqual(files.map((f) => f.filename), [
    "meridian_periods.csv",
    "meridian_closes_2026-08.csv",
    "meridian_curve_2026-08.csv",
  ]);

  const rows = files[0].buffer.toString("utf8").replace(/^﻿/, "").trim().split("\r\n").map((r) => r.split(","));
  assert.deepEqual(rows[0], PERIODS_CSV_COLUMNS);
  const col = (name) => PERIODS_CSV_COLUMNS.indexOf(name);
  assert.equal(rows.length, 4); // header + GROUP + 2 WALLET
  assert.deepEqual(rows.slice(1).map((r) => r[col("scope")]), ["GROUP", "WALLET", "WALLET"]);
  assert.deepEqual(rows.slice(1).map((r) => r[col("wallet_id")]), ["", A.id, B.id]);
  assert.deepEqual(rows.slice(1).map((r) => r[col("internal_eliminated_sol")]), ["2.0000", "", ""]);
  assert.equal(rows[1][col("sealed_at")], ""); // record grup tidak pernah disegel
  assert.notEqual(rows[2][col("sealed_at")], "");

  const curve = files[2].buffer.toString("utf8").replace(/^﻿/, "").trim().split("\r\n");
  assert.deepEqual(curve[0].split(","), CURVE_CSV_COLUMNS);
  assert.equal(curve.length, 1 + 32 * 2); // 32 boundary Agu (1 Agu–1 Sep) × 2 wallet
});

// ── jangkar Dietz: jendela mulai dari aktivitas pertama grup ─────────
// Tahun genesis: ledger mulai di tengah kalender YTD. Bobot Dietz harus
// dihitung atas jendela AKTIF (snapshot pembuka paling awal → as_of), bukan
// sejak 1 Januari — kalau tidak, modal gabung berbobot kecil dan ROI
// meledak (−210% saat kerugian riil −33%, insiden 28 Agu 2026).

test("Dietz grup: jendela dari aktivitas pertama, bukan awal kalender", () => {
  const K = kp("KWal");
  const L = kp("LWal");
  const regKL = {
    version: 1, group_name: "KL", primary: K.id,
    wallets: [regEntry(K, "2026-08-01"), regEntry(L, "2026-08-16")],
  };
  // Tanpa LLM key → net rill = gross = akresi 0.001/hari/wallet.
  writeLedger(K, makeSnapshots({ start: AUG_FROM, end: END, saldo0: 20, price: 200, llmKey: null, llm0: 0, llmStep: 0 }));
  writeLedger(L, makeSnapshots({ start: Date.parse("2026-08-16T00:00:00Z"), end: END, saldo0: 10, price: 200, llmKey: null, llm0: 0, llmStep: 0 }));
  const rec = consolidatePeriod({ kind: "ytd", id: "2026", registry: regKL, now: Date.parse("2026-09-01T00:30:00Z") });

  // Kedua wallet lahir di tengah kalender → saldo awal 0, modal = setoran gabung.
  close(rec.equity.saldo_awal_sol, 0);
  close(rec.equity.deposit_sol, 30);
  close(rec.pnl.net_rill_sol, r9(31 * 0.001 + 16 * 0.001));

  // Jangkar = 1 Agu (snapshot pembuka paling awal), span 31 hari: K berbobot
  // penuh (masuk tepat di jangkar), L berbobot 16/31. Dengan span 1 Jan–1 Sep
  // (bug lama) basisnya cuma 20×31/243 + 10×16/243 ≈ 3.21 → ROI menggelembung.
  const base = 20 + 10 * (16 / 31);
  const expected = Math.round(((31 * 0.001 + 16 * 0.001) / base) * 10000) / 100;
  assert.equal(rec.roi.dietz_pct, expected);
  assert.equal(rec.integrity.integrity_ok, true, rec.integrity.assertions_failed.join("; "));
});

// ── (a) nol Helius di seluruh jalur grup — WAJIB test terakhir ──────

test("aturan nol-walk: seluruh jalur konsolidasi tidak memanggil fetch", () => {
  assert.equal(fetchCalls, 0);
});
