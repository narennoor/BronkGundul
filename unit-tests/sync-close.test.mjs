// State-sync auto-close bookkeeping (incident 12 Aug 2026, era #9 Temuan 3).
//
// The failure reproduced here: close_remove txs falsely declared expired →
// manager gave up → syncOpenPositions noticed the position was gone and marked
// it closed — and NOTHING was booked. The 2.43 SOL XST-SOL cycle of 04:01
// vanished from performance/cash until it was backfilled by hand; four more
// cycles followed the same morning (−11.07 SOL of phantom loss elsewhere).
//
// The contract now: every sync auto-close returns a snapshot from
// syncOpenPositions, and bookkeepSyncAutoClosed writes a performance record
// (settled datapi PnL when indexed, zeros otherwise) with
// exit_execution.cash_complete:false, then schedules a position-account cash
// scan. All numbers are real cycles from lessons.json; addresses are synthetic
// so production entries are never touched.
//
// _setup.mjs isolates all state (state.json, lessons.json, pool-memory.json,
// signal-weights.json, user-config.json, …) into a temp MERIDIAN_STATE_DIR —
// the live files are never touched.

import { statePath } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// A throwaway keypair: bookkeepSyncAutoClosed only needs an address for the
// datapi URL (the fetch itself is injected below). No funds, no chain.
process.env.WALLET_PRIVATE_KEY ||= bs58.encode(Keypair.generate().secretKey);

const { trackPosition, syncOpenPositions } = await import("../state.js");
const { bookkeepSyncAutoClosed } = await import("../tools/dlmm.js");
const { hasPerformanceRecord } = await import("../lessons.js");
const { config } = await import("../config.js");

// Keep the test run from pushing synthetic performance events to the real
// HiveMind — isHiveMindEnabled() reads this live.
config.hiveMind.url = "";
config.hiveMind.apiKey = "";

// The 04:01 XST-SOL cycle, synthetic address.
const POS_XST = "UNITTESTsyncclose11111111111111111111111111";
const POOL_XST = "9aKBzv2QyD3GJdUAYp4w5XhAxRsuGQoq7rkUqoHmfNRd";

const readLessons = () => JSON.parse(fs.readFileSync(statePath("lessons.json"), "utf8"));

function backdateDeploy(position, minutesAgo) {
  const stateFile = statePath("state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.positions[position].deployed_at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// The isolated state dir starts empty, so any position that is not in the
// on-chain "active" list is a candidate for auto-close. Keep the helper anyway:
// it mirrors production (every open position the sync should NOT close is in
// the list) and stays correct if a test ever pre-seeds extra positions.
function otherOpenPositions() {
  const state = JSON.parse(fs.readFileSync(statePath("state.json"), "utf8"));
  return Object.keys(state.positions || {}).filter(
    (id) => !id.startsWith("UNITTEST") && !state.positions[id].closed,
  );
}

test("syncOpenPositions returns the auto-closed snapshot (and respects the grace period)", () => {
  trackPosition({
    position: POS_XST,
    pool: POOL_XST,
    pool_name: "XST-SOL",
    strategy: "bid_ask",
    amount_sol: 2.43,
    deploy_txs: ["deployTx1", "deployTx2", "deployTx3"],
  });

  // Freshly deployed → grace period, no auto-close.
  assert.deepEqual(syncOpenPositions(otherOpenPositions()), [], "a <5min-old position must not be auto-closed");

  // The real cycle ran 03:40:34 → 04:02:35 (22 minutes).
  backdateDeploy(POS_XST, 22);
  const autoClosed = syncOpenPositions(otherOpenPositions());
  const entry = autoClosed.find((p) => p.position === POS_XST);
  assert.ok(entry, "the closed position must be returned to the caller, not silently mutated");
  assert.equal(autoClosed.length, 1, "ONLY the synthetic position may be auto-closed");
  assert.equal(entry.amount_sol, 2.43);
  assert.equal(entry.pool, POOL_XST);
  assert.ok(entry.closed_at);

  assert.equal(syncOpenPositions(otherOpenPositions()).find((p) => p.position === POS_XST), undefined,
    "an already-closed position is not returned twice");
});

test("an auto-close the datapi has not indexed is booked with pending cash + a scheduled scan", async () => {
  const state = JSON.parse(fs.readFileSync(statePath("state.json"), "utf8"));
  const pos = { position: POS_XST, ...state.positions[POS_XST] };

  const recheckCalls = [];
  await bookkeepSyncAutoClosed([pos], {
    delayMs: 0,
    // Production reality at 04:02: the /pnl?status=closed page did not have the
    // cycle (that is why it stayed unbooked for 7 hours).
    fetchImpl: async () => ({ ok: true, json: async () => ({ positions: [] }) }),
    recheck: async (positions) => { recheckCalls.push(positions); return { patched: 0, patches: [] }; },
  });

  const perf = readLessons().performance.find((p) => p.position === POS_XST);
  assert.ok(perf, "the cycle must exist in the books — this is the record that went missing on 12 Aug");
  assert.equal(perf.close_reason, "state-sync auto-close (not found on-chain)");
  assert.equal(perf.amount_sol, 2.43);
  assert.ok(perf.minutes_held >= 21 && perf.minutes_held <= 23, `minutes_held ${perf.minutes_held} ≈ 22`);
  assert.equal(perf.exit_execution.cash_complete, false,
    "until the position-account scan lands, the entry must read as cash-incomplete (the recheck suspect filter keys on this)");
  assert.deepEqual(recheckCalls, [[POS_XST]], "the position-account cash scan must be scheduled");
});

test("a second pass over the same position does not double-book", async () => {
  const state = JSON.parse(fs.readFileSync(statePath("state.json"), "utf8"));
  const pos = { position: POS_XST, ...state.positions[POS_XST] };

  const before = readLessons().performance.filter((p) => p.position === POS_XST).length;
  assert.equal(before, 1);
  const recheckCalls = [];
  await bookkeepSyncAutoClosed([pos], {
    delayMs: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ positions: [] }) }),
    recheck: async (positions) => { recheckCalls.push(positions); return { patched: 0 }; },
  });

  assert.equal(readLessons().performance.filter((p) => p.position === POS_XST).length, 1,
    "a live closePosition racing the sync must not produce a duplicate entry");
  assert.deepEqual(recheckCalls, [], "no rescan for an already-booked cycle");
  assert.equal(hasPerformanceRecord(POS_XST), true);
});

test("an auto-close the datapi HAS indexed is booked with the settled PnL", async () => {
  // Real settled numbers from the XST-SOL 14:49 11 Aug cycle (pnl_pct −0.22%).
  const POS2 = "UNITTESTsyncclose22222222222222222222222222";
  const pos = {
    position: POS2,
    pool: POOL_XST,
    pool_name: "XST-SOL",
    strategy: "bid_ask",
    amount_sol: 2.21,
    deployed_at: new Date(Date.now() - 13 * 60_000).toISOString(),
    closed_at: new Date().toISOString(),
  };

  const recheckCalls = [];
  await bookkeepSyncAutoClosed([pos], {
    delayMs: 0,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        positions: [{
          positionAddress: POS2,
          pnlSol: 0,
          allTimeWithdrawals: { total: { usd: 166.5405604312278, sol: 2.20999741 } },
          allTimeDeposits: { total: { usd: 166.91450013064102, sol: 2.209997416 } },
          allTimeFees: { total: { usd: 3.01497753337e-7, sol: 3.99999999999641e-9 } },
        }],
      }),
    }),
    recheck: async (positions) => { recheckCalls.push(positions); return { patched: 1, patches: [{ after: -0.000263568 }] }; },
  });

  const perf = readLessons().performance.find((p) => p.position === POS2);
  assert.ok(perf);
  assert.equal(perf.pnl_pct, -0.22, "settled datapi PnL, not zeros");
  assert.equal(perf.withdrawals_sol, 2.20999741);
  assert.equal(perf.deposits_sol, 2.209997416);
  assert.equal(perf.minutes_held, 13);
  assert.equal(perf.exit_execution.cash_complete, false,
    "settled PnL is not cash — sol_cycle_net still comes from the position-account scan");
  assert.deepEqual(recheckCalls, [[POS2]]);
});

test("dry (paper) positions are never booked", async () => {
  const recheckCalls = [];
  await bookkeepSyncAutoClosed(
    [{ position: "DRY-UNITTEST111111111111111111111111111111", dry: true, pool: POOL_XST, amount_sol: 1 }],
    { delayMs: 0, fetchImpl: async () => ({ ok: false }), recheck: async (p) => { recheckCalls.push(p); } },
  );
  assert.equal(readLessons().performance.some((p) => String(p.position).startsWith("DRY-UNITTEST")), false);
  assert.deepEqual(recheckCalls, []);
});
