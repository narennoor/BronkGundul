// Fase 6 — pengisian sejarah (equity-seed.js + scripts/seed-equity-ledger.mjs).
//
// Mandated by the design (§13): walk penuh SEKALI per wallet menetapkan
// anchor, lalu seal pembuka; SELESAI KALAU rantai seal tersambung tanpa putus
// (assertion 7 hijau untuk seluruh sejarah). Suite ini membuktikan:
//   - entri seeded: saldo telescoped eksak, source "seeded", SOL-native,
//     modal posisi dari interval buku, window flows dari walk;
//   - guard ABORT menulis-nol: balance bergeser (daemon belum pause), walk
//     tidak mencapai cutoff, anchor tidak cocok dengan entri terukur;
//   - merge placeholder genesis: window diisi, angka terukur dipertahankan;
//   - rerun idempoten: nol Helius, langsung seal+verify;
//   - rantai: assertion 7 hijau + meridian_periods.csv tersambung.
//
// Semua waktu dipin (NOW = 2026-08-28T04:00Z) — suite tidak pernah menua.

import { statePath, ledgerPath } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

process.env.RPC_URL = "http://unit-test.invalid/rpc";
process.env.HELIUS_API_KEY = "unit-test-helius-key";
process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";

const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const mkWallet = () => {
  const k = Keypair.generate();
  return { address: k.publicKey.toString(), secret: bs58.encode(k.secretKey) };
};
const W1 = mkWallet(); // jalur utama: wallet segar
const W2 = mkWallet(); // balance bergeser → abort
const W3 = mkWallet(); // cutoff tak tercapai → abort
const W4 = mkWallet(); // anchor tidak cocok → abort
const W5 = mkWallet(); // merge genesis placeholder

const SOL_MINT = "So11111111111111111111111111111111111111112";
const OTHER = "UNITTESTcounterparty111111111111111111111111";
const POS = "UNITTESTpos11111111111111111111111111111111";
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-08-28T04:00:00Z");
const FROM_MS = Date.parse("2026-08-01T00:00:00Z");
const r9 = (v) => Math.round(v * 1e9) / 1e9;
const sec = (iso) => Date.parse(iso) / 1000;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// ── stub fetch: Helius berhalaman + RPC balance + price + openrouter ─
const scenario = { txs: [], pageSize: 1000, balances: {}, balanceSeq: null };
let fetchCalls = 0;
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj), headers: { get: () => null } });

let balanceCalls = 0;
globalThis.fetch = async (url, opts) => {
  fetchCalls++;
  const u = String(url);
  if (u.includes("api.helius.xyz")) {
    const before = new URL(u).searchParams.get("before");
    const idx = before ? scenario.txs.findIndex((t) => t.signature === before) + 1 : 0;
    return jsonRes(scenario.txs.slice(idx, idx + scenario.pageSize));
  }
  if (u.startsWith(process.env.RPC_URL)) {
    const body = JSON.parse(opts.body);
    if (body.method !== "getBalance") throw new Error(`unexpected RPC ${body.method}`);
    const addr = body.params[0];
    balanceCalls++;
    const lamports = scenario.balanceSeq ? scenario.balanceSeq(addr, balanceCalls) : (scenario.balances[addr] ?? 0);
    return jsonRes({ jsonrpc: "2.0", id: 1, result: { value: lamports } });
  }
  if (u.includes("lite-api.jup.ag")) return jsonRes({ [SOL_MINT]: { usdPrice: 190.2 } });
  if (u.includes("openrouter.ai")) return jsonRes({ data: { usage: 41.22 } });
  throw new Error(`unexpected fetch: ${u}`);
};

const { seedLedger, verifySealChain, buildPrincipalIndex, sealClosedPeriodsFrom } = await import("../equity-seed.js");
const { loadSnapshots, loadPeriods } = await import("../equity-snapshot.js");
const { toPeriodsCsv, PERIODS_CSV_COLUMNS } = await import("../financial-csv.js");

// ── sejarah tx sintetis, hand-computable (ts-desc utk Helius) ────────
// funding +10 (20 Jul) · gas-trade pra-cutoff (25 Jul) · trade harian +0.004
// (fee 0.001) tiap 06:00 sejak 1 Agu · deposit +5 (2 Agu 12:00) · withdrawal
// −1.000005 (10 Agu 09:00) · trade pasca-boundary hari ini (28 Agu 02:00).
function makeHistory(wallet) {
  const wc = (sol) => [{ account: wallet, nativeBalanceChange: Math.round(sol * 1e9) }];
  const txs = [];
  txs.push({ signature: "FUND10", timestamp: sec("2026-07-20T12:00:00Z"), type: "TRANSFER", feePayer: OTHER, fee: 5000, accountData: wc(10), tokenTransfers: [], nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: wallet, amount: 10e9 }] });
  txs.push({ signature: "PREGAS", timestamp: sec("2026-07-25T06:00:00Z"), type: "SWAP", feePayer: wallet, fee: 1e6, accountData: wc(-0.001), tokenTransfers: [{ mint: "X" }], nativeTransfers: [] });
  for (let d = 1; d <= 27; d++) {
    const id = `2026-08-${String(d).padStart(2, "0")}`;
    txs.push({ signature: `TRADE-${id}`, timestamp: sec(`${id}T06:00:00Z`), type: "SWAP", feePayer: wallet, fee: 1e6, accountData: wc(0.004), tokenTransfers: [{ mint: "X" }], nativeTransfers: [] });
  }
  txs.push({ signature: "DEP5", timestamp: sec("2026-08-02T12:00:00Z"), type: "TRANSFER", feePayer: OTHER, fee: 5000, accountData: wc(5), tokenTransfers: [], nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: wallet, amount: 5e9 }] });
  txs.push({ signature: "WD1", timestamp: sec("2026-08-10T09:00:00Z"), type: "TRANSFER", feePayer: wallet, fee: 5000, accountData: wc(-1.000005), tokenTransfers: [], nativeTransfers: [{ fromUserAccount: wallet, toUserAccount: OTHER, amount: 1e9 }] });
  txs.push({ signature: "TRADE-TODAY", timestamp: sec("2026-08-28T02:00:00Z"), type: "SWAP", feePayer: wallet, fee: 1e6, accountData: wc(0.004), tokenTransfers: [{ mint: "X" }], nativeTransfers: [] });
  txs.sort((a, b) => b.timestamp - a.timestamp); // Helius newest-first
  const balance = r9(txs.reduce((s, t) => s + t.accountData[0].nativeBalanceChange / 1e9, 0));
  return { txs, balance };
}
// saldo boundary hand-computed: 9.999 di 1 Agu; +0.004/hari; +5 masuk 3 Agu; −1.000005 masuk 11 Agu
const SALDO_0801 = 9.999;
const SALDO_0803 = r9(9.999 + 2 * 0.004 + 5); // 15.007
const SALDO_0827 = r9(9.999 + 26 * 0.004 + 5 - 1.000005); // 14.102995

function useWallet(w, { history = makeHistory(w.address) } = {}) {
  process.env.WALLET_PRIVATE_KEY = w.secret;
  scenario.txs = history.txs;
  scenario.pageSize = 1000;
  scenario.balanceSeq = null;
  scenario.balances = { [w.address]: Math.round(history.balance * 1e9), [POS]: 0.05e9 };
  return history;
}

// buku: satu close 5 Agu 02:00 (interval terbuka melintasi boundary 5 Agu),
// state: satu posisi LIVE deployed 27 Agu 10:00 (untuk snapshot hari ini)
fs.writeFileSync(statePath("lessons.json"), JSON.stringify({
  performance: [{
    position: "PERFPOS1", pool: "POOL1", pool_name: "TEST-SOL",
    recorded_at: "2026-08-05T02:00:00Z", minutes_held: 240, amount_sol: 2.0,
    pnl_sol: 0.01, pnl_usd: 1.9, fees_earned_sol: 0.005, fees_earned_usd: 0.95,
  }],
}));
fs.writeFileSync(statePath("state.json"), JSON.stringify({
  positions: {
    [POS]: { position: POS, pool: "POOL2", pool_name: "LIVE-SOL", amount_sol: 1.5, deployed_at: "2026-08-27T10:00:00Z", closed: false, closed_at: null, pnl_samples: [] },
  },
}));

// ── jalur utama: wallet segar ────────────────────────────────────────

test("seed wallet segar: telescoping eksak, entri seeded SOL-native, hari ini via jalur normal", async () => {
  useWallet(W1);
  const res = await seedLedger({ from: "2026-08-01", now: NOW });

  assert.equal(res.walked, true);
  assert.equal(res.written.length, 27); // 1–27 Agu; 28 Agu lewat takeSnapshot
  assert.equal(res.written[0], "2026-08-01");
  assert.equal(res.written[26], "2026-08-27");
  assert.deepEqual(res.merged, []);
  assert.deepEqual(res.today, ["2026-08-28"]);

  const snaps = loadSnapshots(W1.address).snapshots;
  assert.equal(snaps.length, 28);
  const byId = new Map(snaps.map((s) => [s.id, s]));

  // anchor pembuka: tanpa window, saldo telescoped
  const first = byId.get("2026-08-01");
  assert.equal(first.source, "seeded");
  close(first.equity.saldo_bebas_sol, SALDO_0801);
  assert.equal(first.integrity.txs, 0);
  assert.equal(first.integrity.trusted, true);
  assert.equal(first.integrity.drift_sol, null); // tautologis — sengaja null
  assert.equal(first.sol_price, null); // SOL-native (§11)
  assert.equal(first.llm_usd_lifetime, null);
  assert.equal(first.market_memo.suspect, true);

  // deposit 2 Agu 12:00 → window entri 3 Agu, tercatat di transfers[]
  const d3 = byId.get("2026-08-03");
  close(d3.equity.saldo_bebas_sol, SALDO_0803);
  close(d3.flows.deposit_in_sol, 5);
  assert.equal(d3.flows.transfers.length, 1);
  assert.equal(d3.flows.transfers[0].sig, "DEP5");
  assert.equal(d3.flows.transfers[0].counterparty, OTHER);

  // withdrawal 10 Agu 09:00 → entri 11 Agu
  close(byId.get("2026-08-11").flows.withdraw_out_sol, 1);

  // modal posisi dari interval buku: PERFPOS1 terbuka melintasi 5 Agu 00:00
  const d5 = byId.get("2026-08-05");
  close(d5.equity.modal_posisi_sol, 2.0);
  close(d5.equity.rent_sol, 0); // rent historis tak terpulihkan
  close(d5.equity.total_sol, r9(d5.equity.saldo_bebas_sol + 2.0));
  close(byId.get("2026-08-04").equity.modal_posisi_sol, 0);

  // book rollup: close recorded 5 Agu 02:00 → window entri 6 Agu
  assert.equal(byId.get("2026-08-06").book.closed, 1);
  close(byId.get("2026-08-06").book.fee_lp_sol, 0.005);

  // hari ini lewat jalur inkremental NORMAL: enriched live
  const today = byId.get("2026-08-28");
  assert.equal(today.source, "light");
  assert.equal(today.sol_price, 190.2);
  close(today.equity.modal_posisi_sol, r9(1.5 + 0.05)); // principal + rent live
  // saldo boundary = balance sekarang − trade pasca-boundary (28 Agu 02:00)
  close(today.equity.saldo_bebas_sol, SALDO_0827 + 0.004);
  // gas window [27, 28): trade 27 Agu 06:00
  close(today.flows.gas_sol, 0.001);
});

test("seal pembuka: minggu parsial dilewati, W32–W34 tersegel, rantai hijau", () => {
  const periods = loadPeriods(W1.address).periods;
  assert.deepEqual(periods.map((p) => `${p.kind} ${p.id}`), ["week 2026-W32", "week 2026-W33", "week 2026-W34"]);
  for (const p of periods) {
    assert.equal(p.integrity.integrity_ok, true, `${p.id}: ${p.integrity.assertions_failed}`);
    assert.equal(p.integrity.windows, 7);
  }
  // W33 membawa withdrawal −1 (10 Agu 09:00 ∈ (10 Agu, 17 Agu])
  const w33 = periods.find((p) => p.id === "2026-W33");
  close(w33.equity.withdrawal_sol, -1.000005 + 0.000005); // nativeTransfer 1 SOL yang diklasifikasi
  // rantai eksplisit: saldo_awal[N] == total_ekuitas[N−1]
  const w32 = periods.find((p) => p.id === "2026-W32");
  close(w33.equity.saldo_awal_sol, w32.equity.total_ekuitas_sol);

  const chain = verifySealChain(W1.address);
  assert.equal(chain.ok, true, chain.problems.join("; "));
  assert.deepEqual(chain.counts, { week: 3, month: 0, year: 0 });
});

test("SELESAI-KALAU: meridian_periods.csv tersambung tanpa putus rantai", () => {
  const periods = loadPeriods(W1.address).periods;
  const rows = toPeriodsCsv(periods, { walletId: "W1" }).toString("utf8").replace(/^﻿/, "").trim().split("\r\n").map((r) => r.split(","));
  assert.equal(rows.length, 4); // header + 3 minggu
  const col = (n) => PERIODS_CSV_COLUMNS.indexOf(n);
  for (let i = 2; i < rows.length; i++) {
    assert.equal(rows[i][col("saldo_awal_sol")], rows[i - 1][col("total_ekuitas_sol")], `baris ${i} putus rantai`);
  }
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i][col("integrity_ok")], "true");
});

test("rerun idempoten: nol Helius, langsung seal+verify", async () => {
  useWallet(W1);
  const callsBefore = fetchCalls;
  const res = await seedLedger({ from: "2026-08-01", now: NOW });
  assert.equal(res.walked, false);
  assert.deepEqual(res.written, []);
  assert.equal(res.skippedSeals.length, 3); // W32–W34 sudah tersegel
  assert.equal(res.chain.ok, true);
  assert.equal(fetchCalls, callsBefore); // rantai penuh tanpa satu pun fetch
});

// ── guard ABORT menulis-nol ──────────────────────────────────────────

test("balance bergeser selama walk (daemon belum pause) → abort, nol tulis", async () => {
  const hist = makeHistory(W2.address);
  useWallet(W2, { history: hist });
  let n = 0;
  scenario.balanceSeq = (addr) => Math.round(hist.balance * 1e9) + (n++ === 0 ? 0 : 7e6); // +0.007 pada baca kedua
  await assert.rejects(() => seedLedger({ from: "2026-08-01", now: NOW }), /Balance bergeser/);
  assert.equal(fs.existsSync(ledgerPath(W2.address, "snapshots.json")), false);
});

test("walk tidak mencapai cutoff → abort, nol tulis", async () => {
  useWallet(W3);
  scenario.pageSize = 3; // 3 tx terbaru semuanya ≥ cutoff
  await assert.rejects(() => seedLedger({ from: "2026-08-01", now: NOW, maxPages: 1 }), /tidak mencapai cutoff/);
  assert.equal(fs.existsSync(ledgerPath(W3.address, "snapshots.json")), false);
});

test("anchor tidak cocok dengan entri terukur → abort, ledger tak tersentuh", async () => {
  useWallet(W4);
  fs.mkdirSync(ledgerPath(W4.address), { recursive: true });
  const genesis = {
    id: "2026-08-27", boundary_ts: "2026-08-27T00:00:00Z", taken_at: "2026-08-27T00:05:00Z", source: "genesis",
    equity: { saldo_bebas_sol: r9(SALDO_0827 + 0.5), modal_posisi_sol: 2.39, principal_sol: 2.29, rent_sol: 0.1, total_sol: r9(SALDO_0827 + 0.5 + 2.39) },
    market_memo: { nilai_pasar_sol: 2.4, suspect: false },
    flows: { deposit_in_sol: 0, withdraw_out_sol: 0, gas_sol: 0, gas_txn: 0, transfers: [] },
    book: { closed: 0, wins: 0, fee_lp_sol: 0, net_revenue_sol: 0, liquidation_gap_sol: 0 },
    sol_price: 104.25, llm_usd_lifetime: 1.29, llm_key_id: "livekey1",
    integrity: { delta_balance_sol: null, flow_sum_sol: 0, drift_sol: null, trusted: true, txs: 0 },
    window_sigs: [],
  };
  fs.writeFileSync(ledgerPath(W4.address, "snapshots.json"), JSON.stringify({ version: 1, address: W4.address, snapshots: [genesis] }));
  await assert.rejects(() => seedLedger({ from: "2026-08-01", now: NOW }), /Anchor tidak cocok/);
  const after = loadSnapshots(W4.address).snapshots;
  assert.equal(after.length, 1);
  assert.equal(after[0].integrity.txs, 0); // tak tersentuh
});

// ── merge placeholder genesis ────────────────────────────────────────

test("genesis placeholder: saldo tervalidasi, window diisi, angka terukur dipertahankan", async () => {
  useWallet(W5);
  fs.mkdirSync(ledgerPath(W5.address), { recursive: true });
  const genesis = {
    id: "2026-08-27", boundary_ts: "2026-08-27T00:00:00Z", taken_at: "2026-08-27T12:21:00Z", source: "genesis",
    equity: { saldo_bebas_sol: SALDO_0827, modal_posisi_sol: 2.39, principal_sol: 2.29, rent_sol: 0.1, total_sol: r9(SALDO_0827 + 2.39) },
    market_memo: { nilai_pasar_sol: 2.4, suspect: false },
    flows: { deposit_in_sol: 0, withdraw_out_sol: 0, gas_sol: 0, gas_txn: 0, transfers: [] },
    book: { closed: 0, wins: 0, fee_lp_sol: 0, net_revenue_sol: 0, liquidation_gap_sol: 0 },
    sol_price: 104.25, llm_usd_lifetime: 1.29, llm_key_id: "livekey1",
    integrity: { delta_balance_sol: null, flow_sum_sol: 0, drift_sol: null, trusted: true, txs: 0 },
    window_sigs: [],
  };
  fs.writeFileSync(ledgerPath(W5.address, "snapshots.json"), JSON.stringify({ version: 1, address: W5.address, snapshots: [genesis] }));

  const res = await seedLedger({ from: "2026-08-01", now: NOW });
  assert.deepEqual(res.merged, ["2026-08-27"]);
  assert.equal(res.written.length, 26); // 1–26 Agu (27 Agu = merge)
  assert.equal(res.validated.length, 1);

  const byId = new Map(loadSnapshots(W5.address).snapshots.map((s) => [s.id, s]));
  const g = byId.get("2026-08-27");
  assert.equal(g.source, "genesis"); // identitas entri tetap
  close(g.equity.saldo_bebas_sol, SALDO_0827); // angka terukur dipertahankan
  close(g.equity.modal_posisi_sol, 2.39);
  assert.equal(g.sol_price, 104.25);
  assert.equal(g.llm_key_id, "livekey1");
  close(g.flows.gas_sol, 0.001); // window [26, 27) kini terisi: trade 26 Agu 06:00
  assert.equal(g.integrity.txs, 1);
  assert.equal(g.integrity.trusted, true);

  const chain = verifySealChain(W5.address);
  assert.equal(chain.ok, true, chain.problems.join("; "));
  assert.deepEqual(chain.counts, { week: 3, month: 0, year: 0 });
});
