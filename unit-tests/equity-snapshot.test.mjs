// Equity ledger (equity-snapshot.js) — fase 1 of the financial report.
//
// Covers the three mandated tests of the design:
//   (a) zero-walk: reading/folding 90-day ledgers for two wallets touches the
//       network exactly zero times,
//   (g) sign conventions: gross_rill == net_revenue + exec_cost + gas_fee with
//       costs stored negative on the signed side,
//   (h) the pnl-report extraction (walletChange/classifyCashFlows →
//       utils/chain-flows.js) — enforced by the existing pnl-cutoff.test.mjs
//       staying green, not here,
// plus the walk mechanics: window assignment, overlap signature dedup,
// late-indexed tx conservation, integrity drift, idempotency, multi-day
// derived backfill, and interior-hole healing.
//
// Fully offline: globalThis.fetch is stubbed per test; _setup.mjs points both
// MERIDIAN_STATE_DIR and MERIDIAN_LEDGER_DIR at a temp tree, so the suite is
// safe to run while the daemons are up.

import { statePath, ledgerPath } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import crypto from "crypto";

process.env.RPC_URL = "http://unit-test.invalid/rpc";
process.env.HELIUS_API_KEY = "unit-test-helius-key";
process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";

const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const kp = Keypair.generate();
process.env.WALLET_PRIVATE_KEY = bs58.encode(kp.secretKey);
const WALLET = kp.publicKey.toString();

const {
  takeSnapshot,
  loadSnapshots,
  snapshotAtOrBefore,
  healGap,
  findMissingIds,
  buildWindowSnapshot,
  dayBoundaryUtc,
  snapshotIdFor,
  resolveLedgerDir,
} = await import("../equity-snapshot.js");
const { writeJsonAtomic, readJsonStore } = await import("../utils/json-store.js");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const POS = "UNITTESTpos11111111111111111111111111111111";
const OTHER = "UNITTESTcounterparty111111111111111111111111";
const DAY = 24 * 3600 * 1000;

// UTC boundaries for the scenario arc (genesis 25 Aug … multi-day 31 Aug).
const B0 = Date.parse("2026-08-25T00:00:00Z");
const B1 = B0 + DAY; // 26 Aug
const B2 = B1 + DAY; // 27 Aug
const B3 = B2 + DAY; // 28 Aug

const sec = (ms) => Math.floor(ms / 1000);
const iso = (ms) => new Date(ms).toISOString();
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// ── fetch stub ───────────────────────────────────────────────────────
// scenario = { helius: [tx…] (ts-desc), balances: { [addr]: lamports }, solPrice }
const scenario = { helius: [], balances: {}, solPrice: 190.2 };
let fetchCalls = 0;
let fetchForbidden = false;

function jsonRes(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    headers: { get: () => null },
  };
}

globalThis.fetch = async (url, opts) => {
  fetchCalls++;
  if (fetchForbidden) throw new Error(`zero-walk violated: fetch(${String(url).slice(0, 80)})`);
  const u = String(url);
  if (u.includes("api.helius.xyz")) {
    const before = new URL(u).searchParams.get("before");
    if (!before) return jsonRes(scenario.helius);
    const idx = scenario.helius.findIndex((t) => t.signature === before);
    return jsonRes(idx >= 0 ? scenario.helius.slice(idx + 1) : []);
  }
  if (u.startsWith(process.env.RPC_URL)) {
    const body = JSON.parse(opts.body);
    if (body.method !== "getBalance") throw new Error(`unexpected RPC method ${body.method}`);
    const lamports = scenario.balances[body.params[0]] ?? 0;
    return jsonRes({ jsonrpc: "2.0", id: 1, result: { value: lamports } });
  }
  if (u.includes("lite-api.jup.ag")) return jsonRes({ [SOL_MINT]: { usdPrice: scenario.solPrice } });
  if (u.includes("openrouter.ai")) return jsonRes({ data: { usage: 41.22 } });
  throw new Error(`unexpected fetch: ${u}`);
};

// ── fixtures ─────────────────────────────────────────────────────────

function mkTx(sig, tsSec, wcSol, extra = {}) {
  return {
    signature: sig,
    timestamp: tsSec,
    type: extra.type ?? "TRANSFER",
    feePayer: extra.feePayer ?? OTHER,
    fee: extra.feeLamports ?? 5000,
    accountData: [{ account: WALLET, nativeBalanceChange: Math.round(wcSol * 1e9) }],
    tokenTransfers: extra.tokenTransfers ?? [],
    nativeTransfers: extra.nativeTransfers ?? [],
  };
}

function writeStateFixture(nowMs) {
  fs.writeFileSync(
    statePath("state.json"),
    JSON.stringify({
      positions: {
        [POS]: {
          position: POS,
          pool: "UNITTESTpool1111111111111111111111111111111",
          pool_name: "TEST-SOL",
          amount_sol: 3.0,
          deployed_at: "2026-08-20T10:00:00Z",
          closed: false,
          closed_at: null,
          pnl_samples: [{ t: iso(nowMs - 2 * 60 * 1000), p: 1.3 }],
        },
        DRYPOS: {
          position: "DRY-UNITTEST",
          dry: true,
          amount_sol: 99,
          deployed_at: "2026-08-20T10:00:00Z",
          closed: false,
        },
      },
    }),
  );
}

function writeLessonsFixture() {
  fs.writeFileSync(
    statePath("lessons.json"),
    JSON.stringify({
      performance: [
        // in window [B0, B1): a win with native SOL fees and a measured gap
        {
          recorded_at: iso(B0 + 2 * 3600 * 1000),
          pnl_usd: 9.5,
          pnl_sol: 0.05,
          fees_earned_sol: 0.08,
          exit_execution: { cash_complete: true, liquidation_gap_sol: -0.004 },
        },
        // in window: a loss with USD-only fees (fallback path, 1.902 / 190.2 = 0.01)
        { recorded_at: iso(B0 + 3 * 3600 * 1000), pnl_usd: -1.0, pnl_sol: -0.01, fees_earned_usd: 1.902 },
        // before the window — must be excluded
        { recorded_at: iso(B0 - 2 * 3600 * 1000), pnl_usd: 100, pnl_sol: 1.0 },
      ],
      performance_archive: [
        // archived close inside the window — counted like any other
        { recorded_at: iso(B0 + 4 * 3600 * 1000), pnl_usd: 0.5, pnl_sol: 0.002 },
      ],
    }),
  );
}

// ── time helpers ─────────────────────────────────────────────────────

test("dayBoundaryUtc / snapshotIdFor pin to 00:00:00Z", () => {
  assert.equal(dayBoundaryUtc(Date.parse("2026-08-27T00:05:11Z")), Date.parse("2026-08-27T00:00:00Z"));
  assert.equal(dayBoundaryUtc(Date.parse("2026-08-27T23:59:59Z")), Date.parse("2026-08-27T00:00:00Z"));
  assert.equal(snapshotIdFor(Date.parse("2026-08-27T00:00:00Z")), "2026-08-27");
});

test("resolveLedgerDir honors MERIDIAN_LEDGER_DIR (test isolation)", () => {
  assert.equal(resolveLedgerDir(), path.resolve(process.env.MERIDIAN_LEDGER_DIR));
});

// ── the scenario arc: genesis → clean day → index-lag day → conservation day ──

test("genesis: first snapshot pins balance to the boundary, no window", async (t) => {
  const now = B0 + 5 * 60 * 1000; // 25 Aug 00:05Z
  writeStateFixture(now);
  writeLessonsFixture();
  scenario.helius = [mkTx("pb1", sec(B0) + 60, -0.1)]; // landed 00:01, after the boundary
  scenario.balances = { [WALLET]: 12.5e9, [POS]: 0.109e9 };

  const res = await takeSnapshot({ now });
  assert.deepEqual(res.written, ["2026-08-25"]);
  const s = res.snapshot;
  assert.equal(s.source, "genesis");
  assert.equal(s.boundary_ts, "2026-08-25T00:00:00Z");
  assert.equal(s.taken_at, iso(now));
  // balance now (12.5) minus the post-boundary tx (−0.1) → 12.6 at 00:00Z
  close(s.equity.saldo_bebas_sol, 12.6);
  // at cost: principal 3.0 (dry position excluded) + rent 0.109 read from the
  // position account's own lamports
  close(s.equity.principal_sol, 3.0);
  close(s.equity.rent_sol, 0.109);
  close(s.equity.modal_posisi_sol, 3.109);
  close(s.equity.total_sol, 15.709);
  // market memo from the fresh pnl_samples tick: 3.0 × 1.013
  close(s.market_memo.nilai_pasar_sol, 3.039);
  assert.equal(s.market_memo.suspect, false);
  assert.equal(s.sol_price, 190.2);
  assert.equal(s.llm_usd_lifetime, 41.22);
  assert.equal(
    s.llm_key_id,
    crypto.createHash("sha256").update("unit-test-openrouter-key").digest("hex").slice(0, 8),
  );
  assert.equal(s.integrity.txs, 0);
  assert.equal(s.integrity.delta_balance_sol, null);
  assert.equal(s.integrity.trusted, true);
  assert.ok(fs.existsSync(ledgerPath(WALLET, "snapshots.json")));
});

test("takeSnapshot is idempotent — same day again writes nothing, fetches nothing", async () => {
  const before = fetchCalls;
  const res = await takeSnapshot({ now: B0 + 6 * 60 * 1000 });
  assert.equal(res.skipped, "2026-08-25");
  assert.deepEqual(res.written, []);
  assert.equal(fetchCalls, before, "the skip path must not touch the network");
  assert.equal(loadSnapshots(WALLET).snapshots.length, 1);
});

test("day 2 (clean): window flows, boundary balance, transfers[], book rollup", async () => {
  const now = B1 + 5 * 60 * 1000; // 26 Aug 00:05Z
  writeStateFixture(now);
  scenario.helius = [
    // ts-desc. gasT sits in the last 15 min of the window → inside the sig
    // horizon, so day 3's overlap walk must dedup it.
    mkTx("gasT", sec(B1) - 900, -0.006, {
      feePayer: WALLET,
      feeLamports: 6e6,
      tokenTransfers: [{ mint: "X", fromUserAccount: WALLET, toUserAccount: OTHER, tokenAmount: 1 }],
    }),
    mkTx("dep1", sec(B0) + 3600, 2.0, {
      nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, amount: 2e9 }],
    }),
    mkTx("pb1", sec(B0) + 60, -0.1), // counted NOW — it belongs to [B0, B1)
  ];
  scenario.balances[WALLET] = Math.round((12.5 + 2.0 - 0.006) * 1e9); // 14.494

  const res = await takeSnapshot({ now });
  assert.deepEqual(res.written, ["2026-08-26"]);
  const s = res.snapshot;
  assert.equal(s.source, "light");
  close(s.equity.saldo_bebas_sol, 14.494);
  // flows: magnitudes per the §07 shape
  close(s.flows.deposit_in_sol, 2.0);
  close(s.flows.withdraw_out_sol, 0);
  close(s.flows.gas_sol, 0.006);
  assert.equal(s.flows.gas_txn, 1);
  assert.deepEqual(s.flows.transfers, [
    { sig: "dep1", ts: sec(B0) + 3600, dir: "in", counterparty: OTHER, amount_sol: 2.0 },
  ]);
  // integrity: Δbalance (14.494 − 12.6) == Σ walletChange (2 − 0.006 − 0.1)
  close(s.integrity.delta_balance_sol, 1.894);
  close(s.integrity.flow_sum_sol, 1.894);
  close(s.integrity.drift_sol, 0);
  assert.equal(s.integrity.trusted, true);
  assert.equal(s.integrity.txs, 3);
  // book: 2 perf + 1 archived close in-window; the pre-window entry excluded
  assert.equal(s.book.closed, 3);
  assert.equal(s.book.wins, 2); // pnl_usd >= 0 convention
  close(s.book.net_revenue_sol, 0.042); // 0.05 − 0.01 + 0.002
  close(s.book.fee_lp_sol, 0.09); // 0.08 native + 1.902/190.2
  close(s.book.liquidation_gap_sol, -0.004); // nested in exit_execution
  // only txs inside the overlap re-fetch horizon keep their sigs
  assert.deepEqual(s.window_sigs, ["gasT"]);
});

test("day 3 (index lag): a landed-but-unlisted tx shows up as positive drift", async () => {
  const now = B2 + 5 * 60 * 1000; // 27 Aug 00:05Z
  writeStateFixture(now);
  // tLate (+0.5, blocktime 26 Aug 23:50) has LANDED — the RPC balance knows it —
  // but Helius's enhanced listing doesn't return it yet.
  scenario.helius = [
    mkTx("tOk", sec(B2) - 1200, -0.02, {
      feePayer: WALLET,
      feeLamports: 2e7,
      tokenTransfers: [{ mint: "X", fromUserAccount: WALLET, toUserAccount: OTHER, tokenAmount: 1 }],
    }),
    ...scenario.helius, // day-2 txs remain in history
  ];
  scenario.balances[WALLET] = Math.round((14.494 - 0.02 + 0.5) * 1e9); // 14.974

  const res = await takeSnapshot({ now });
  const s = res.snapshot;
  assert.equal(s.id, "2026-08-27");
  close(s.equity.saldo_bebas_sol, 14.974);
  close(s.integrity.delta_balance_sol, 0.48);
  close(s.integrity.flow_sum_sol, -0.02);
  close(s.integrity.drift_sol, 0.5); // the missing flow, caught
  assert.equal(s.integrity.trusted, false);
});

test("day 4 (conservation): the late tx surfaces once, drifts cancel, dedup holds", async () => {
  const now = B3 + 5 * 60 * 1000; // 28 Aug 00:05Z
  writeStateFixture(now);
  // tLate finally appears in the listing, at its true blocktime (day-3 window).
  scenario.helius = [mkTx("tLate", sec(B2) - 600, 0.5), ...scenario.helius];
  // no new on-chain movement since day 3
  const res = await takeSnapshot({ now });
  const s = res.snapshot;
  assert.equal(s.id, "2026-08-28");
  close(s.equity.saldo_bebas_sol, 14.974);
  // tLate is counted exactly once (conservation) even though its blocktime is
  // before this window; tOk, re-fetched by the 30-min overlap, is deduped via
  // day 3's window_sigs.
  close(s.integrity.flow_sum_sol, 0.5);
  close(s.integrity.delta_balance_sol, 0);
  close(s.integrity.drift_sol, -0.5);
  assert.equal(s.integrity.trusted, false);
  assert.equal(s.integrity.txs, 1);

  const all = loadSnapshots(WALLET).snapshots;
  const day3 = all.find((x) => x.id === "2026-08-27");
  close(day3.integrity.drift_sol + s.integrity.drift_sol, 0, 1e-9); // money conserved
  // and the flow itself is never double counted across the ledger
  const totalFlow = all.reduce((sum, x) => sum + (x.integrity.flow_sum_sol || 0), 0);
  close(totalFlow, 1.894 - 0.02 + 0.5);
});

test("multi-day catch-up: missed boundaries become derived entries, today stays light", async () => {
  const now = Date.parse("2026-08-31T00:05:00Z"); // daemon was down 29–30 Aug
  writeStateFixture(now);
  const res = await takeSnapshot({ now });
  assert.deepEqual(res.written, ["2026-08-29", "2026-08-30", "2026-08-31"]);
  const all = loadSnapshots(WALLET).snapshots;
  const d29 = all.find((x) => x.id === "2026-08-29");
  const d30 = all.find((x) => x.id === "2026-08-30");
  const d31 = all.find((x) => x.id === "2026-08-31");
  assert.equal(d29.source, "derived");
  assert.equal(d30.source, "derived");
  assert.equal(d31.source, "light");
  // derived windows: SOL-native only, never trusted
  assert.equal(d29.sol_price, null);
  assert.equal(d29.integrity.trusted, false);
  assert.equal(d29.market_memo.suspect, true);
  assert.equal(d31.integrity.trusted, true); // quiet days: drift 0
  close(d31.equity.saldo_bebas_sol, 14.974);
});

test("healGap heals ONLY the interior hole, leaves neighbors untouched", async () => {
  // Fabricate a hole: drop the derived 2026-08-30 entry from the file.
  const file = ledgerPath(WALLET, "snapshots.json");
  const store = readJsonStore(file, null);
  const removed = store.snapshots.find((s) => s.id === "2026-08-30");
  assert.ok(removed);
  store.snapshots = store.snapshots.filter((s) => s.id !== "2026-08-30");
  writeJsonAtomic(file, store);
  const before = JSON.stringify(
    readJsonStore(file, null).snapshots.filter((s) => s.id !== "2026-08-30"),
  );

  const res = await healGap();
  assert.deepEqual(res.written, ["2026-08-30"]);
  const after = readJsonStore(file, null);
  assert.deepEqual(after.snapshots.map((s) => s.id).slice(-4), ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"]);
  const healed = after.snapshots.find((s) => s.id === "2026-08-30");
  assert.equal(healed.source, "derived");
  assert.equal(healed.integrity.trusted, false);
  // balance anchored backward from the snapshot AFTER the hole
  close(healed.equity.saldo_bebas_sol, 14.974);
  // every other entry byte-identical
  assert.equal(JSON.stringify(after.snapshots.filter((s) => s.id !== "2026-08-30")), before);
});

test("healGap on a complete ledger returns immediately — no walk, no writes", async () => {
  const before = fetchCalls;
  const res = await healGap();
  assert.deepEqual(res.written, []);
  assert.equal(fetchCalls, before);
});

// ── test (a): the zero-walk rule ─────────────────────────────────────

function fakeLedger(address, startIso, days) {
  let saldo = 10;
  const snapshots = [];
  for (let i = 0; i < days; i++) {
    const boundary = Date.parse(startIso) + i * DAY;
    const prevSaldo = i === 0 ? null : saldo;
    const dep = i % 30 === 10 ? 2 : 0; // a deposit now and then
    saldo = Math.round((saldo + dep + 0.001 - 0.0005) * 1e9) / 1e9;
    snapshots.push({
      id: snapshotIdFor(boundary),
      boundary_ts: new Date(boundary).toISOString().replace(".000Z", "Z"),
      taken_at: iso(boundary + 5 * 60 * 1000),
      source: i === 0 ? "genesis" : "light",
      equity: { saldo_bebas_sol: saldo, modal_posisi_sol: 0, principal_sol: 0, rent_sol: 0, total_sol: saldo },
      market_memo: { nilai_pasar_sol: 0, suspect: false },
      flows: { deposit_in_sol: dep, withdraw_out_sol: 0, gas_sol: 0.0005, gas_txn: 2, transfers: [] },
      book: { closed: 2, wins: 1, fee_lp_sol: 0.002, net_revenue_sol: 0.001, liquidation_gap_sol: 0 },
      sol_price: 190,
      llm_usd_lifetime: 10 + i,
      llm_key_id: address === WALLET ? "aaaaaaaa" : "bbbbbbbb",
      integrity: {
        delta_balance_sol: prevSaldo == null ? null : Math.round((saldo - prevSaldo) * 1e9) / 1e9,
        flow_sum_sol: prevSaldo == null ? 0 : Math.round((saldo - prevSaldo) * 1e9) / 1e9,
        drift_sol: prevSaldo == null ? null : 0,
        trusted: true,
        txs: 2,
      },
      window_sigs: [],
    });
  }
  const file = ledgerPath(address, "snapshots.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { version: 1, address, snapshots });
}

test("test a — nol-walk: a 90-day two-wallet monthly group fold makes ZERO fetch calls", async () => {
  const W1 = "UNITTESTwalletA1111111111111111111111111111";
  const W2 = "UNITTESTwalletB1111111111111111111111111111";
  fakeLedger(W1, "2026-06-01T00:00:00Z", 90);
  fakeLedger(W2, "2026-06-01T00:00:00Z", 90);

  const before = fetchCalls;
  fetchForbidden = true; // any Helius/RPC/price call now THROWS
  try {
    // The phase-2/5 consolidation read pattern, stated as plain arithmetic
    // over local files: endpoints from snapshotAtOrBefore, additive rows
    // summed across the window, group = Σ wallets. When sealPeriod and
    // consolidatePeriod exist, they slot into this same block.
    const monthFrom = Date.parse("2026-07-01T00:00:00Z");
    const monthTo = Date.parse("2026-08-01T00:00:00Z");
    const group = { deposit: 0, gas: 0, net_revenue: 0, saldo_awal: 0, total_ekuitas: 0 };
    for (const w of [W1, W2]) {
      const { snapshots } = loadSnapshots(w);
      assert.equal(snapshots.length, 90);
      const opening = snapshotAtOrBefore(snapshots, monthFrom);
      const closing = snapshotAtOrBefore(snapshots, monthTo - 1);
      assert.equal(opening.id, "2026-07-01");
      assert.equal(closing.id, "2026-07-31");
      group.saldo_awal += opening.equity.total_sol;
      group.total_ekuitas += closing.equity.total_sol;
      for (const s of snapshots) {
        const b = Date.parse(s.boundary_ts);
        if (b > monthFrom && b <= monthTo) {
          group.deposit += s.flows.deposit_in_sol;
          group.gas += s.flows.gas_sol;
          group.net_revenue += s.book.net_revenue_sol;
        }
      }
      assert.deepEqual(findMissingIds(snapshots), []);
    }
    close(group.deposit, 4); // one 2-SOL deposit per wallet in July
    assert.ok(group.total_ekuitas > group.saldo_awal);
    // gap detection over the real wallet's ledger is pure too
    assert.deepEqual(findMissingIds(loadSnapshots(WALLET).snapshots), []);
  } finally {
    fetchForbidden = false;
  }
  assert.equal(fetchCalls, before, "report-side reads must never call Helius/RPC");
});

// ── test (g): sign conventions ───────────────────────────────────────

test("test g — gross_rill == net_revenue + exec_cost + gas_fee (signed, costs negative)", () => {
  // A position (principal 1.0, rent 0.1) closes during the window with book
  // pnl +0.05; a 2 SOL external deposit lands; gas 0.006. All flows accounted,
  // so the execution-cost residual must be exactly 0 — any sign slip on gas or
  // deposit would surface as a ±0.012 / ±4 residual.
  const prev = { saldo_bebas_sol: 10.0, total_sol: 11.1 }; // incl. modal posisi 1.1
  const boundaryMs = B1;
  const windowTxs = [
    mkTx("dep", sec(B0) + 1000, 2.0, {
      nativeTransfers: [{ fromUserAccount: OTHER, toUserAccount: WALLET, amount: 2e9 }],
    }),
    // close cycle: principal 1.0 + rent 0.1 + pnl 0.05 − gas 0.006 back to the wallet
    mkTx("closeCycle", sec(B0) + 2000, 1.144, {
      feePayer: WALLET,
      feeLamports: 6e6,
      tokenTransfers: [{ mint: "X", fromUserAccount: OTHER, toUserAccount: WALLET, tokenAmount: 1 }],
    }),
  ];
  const entry = buildWindowSnapshot({
    id: "2026-08-26",
    boundaryMs,
    takenAtIso: iso(B1 + 300000),
    source: "light",
    wallet: WALLET,
    windowTxs,
    saldoBebasSol: 13.144, // 10 + 2 + 1.144
    positions: [], // the position is closed at this boundary
    rentSol: 0,
    marketMemo: { nilai_pasar_sol: 0, suspect: false },
    bookEntries: [{ recorded_at: iso(B0 + 3000 * 1000), pnl_usd: 9.5, pnl_sol: 0.05, fees_earned_sol: 0.08 }],
    solPrice: 190.2,
    prevSaldoBebasSol: prev.saldo_bebas_sol,
    driftToleranceSol: 0.001,
  });

  // §07 shape — every top-level key present (+ llm_credits, memo kas §14)
  assert.deepEqual(Object.keys(entry), [
    "id", "boundary_ts", "taken_at", "source", "equity", "market_memo",
    "flows", "book", "sol_price", "llm_usd_lifetime", "llm_key_id", "llm_credits",
    "integrity", "window_sigs",
  ]);
  assert.deepEqual(Object.keys(entry.equity), [
    "saldo_bebas_sol", "modal_posisi_sol", "principal_sol", "rent_sol", "total_sol",
  ]);

  // stored flows are magnitudes; the SIGNED convention applies on the bridge
  close(entry.flows.deposit_in_sol, 2.0);
  close(entry.flows.gas_sol, 0.006);
  close(entry.integrity.flow_sum_sol, 3.144);
  close(entry.integrity.drift_sol, 0);
  assert.equal(entry.integrity.trusted, true);

  // the signed identity: pendapatan positif, biaya negatif
  const netRevenue = entry.book.net_revenue_sol; // +0.05
  const gasFee = -entry.flows.gas_sol; //           −0.006
  const depositNet = entry.flows.deposit_in_sol - entry.flows.withdraw_out_sol;
  const grossRill = entry.equity.total_sol - prev.total_sol - depositNet;
  const execCost = grossRill - netRevenue - gasFee; // the residual (plug) row
  close(grossRill, 0.044);
  close(execCost, 0);
  close(grossRill, netRevenue + execCost + gasFee); // gross_rill == net_revenue + exec_cost + gas_fee
  // and IL stays signed: fee_lp 0.08 vs net_revenue 0.05 → IL −0.03 (negative)
  close(entry.book.net_revenue_sol - entry.book.fee_lp_sol, -0.03);
});

// ── smaller lookups ──────────────────────────────────────────────────

test("snapshotAtOrBefore: exact boundary, mid-period, and before-history", () => {
  const { snapshots } = loadSnapshots(WALLET);
  assert.equal(snapshotAtOrBefore(snapshots, "2026-08-26").id, "2026-08-26");
  assert.equal(snapshotAtOrBefore(snapshots, Date.parse("2026-08-27T13:00:00Z")).id, "2026-08-27");
  assert.equal(snapshotAtOrBefore(snapshots, "2026-08-24"), null);
  assert.throws(() => snapshotAtOrBefore(snapshots, "bukan tanggal"), /tidak valid/);
});

test("findMissingIds flags interior holes only", () => {
  const mk = (id) => ({ id, boundary_ts: `${id}T00:00:00Z` });
  assert.deepEqual(findMissingIds([mk("2026-08-25"), mk("2026-08-28")]), ["2026-08-26", "2026-08-27"]);
  assert.deepEqual(findMissingIds([mk("2026-08-25")]), []);
  assert.deepEqual(findMissingIds([]), []);
});
