// Closed-position archive (16 Sep 2026 CPU incident).
//
// state.json kept every position ever opened — 1,169 entries / 8.9 MB — and
// every state.js call is a full load()+save(), so the 3s PnL poller was
// parsing and rewriting ~200 MB of JSON per tick on a 2-core VPS: one core
// pinned for 9 hours, ticks stretched to ~10s. The contract now: state.json
// holds OPEN positions only; a close moves the entry to state-closed.json,
// and every reader that needs history sees both files.
//
// _setup.mjs isolates all state into a temp MERIDIAN_STATE_DIR — the live
// files are never touched.

import { statePath } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

const {
  trackPosition, recordClose, recordCloseTxAttempt, getCloseTxAttempts,
  getTrackedPosition, getTrackedPositions, getAllPositionsMap, getStateSummary,
  getTrailingTrace, syncOpenPositions, archiveClosedPositions,
} = await import("../state.js");

const readState = () => JSON.parse(fs.readFileSync(statePath("state.json"), "utf8"));
const readClosed = () => JSON.parse(fs.readFileSync(statePath("state-closed.json"), "utf8"));

const OPEN = "UNITTESTarchiveOpen111111111111111111111111";
const CLOSED = "UNITTESTarchiveClosed11111111111111111111111";
const POOL = "HnNir1tJhkHei2tebBq26CzCN6QXaB2GDnN3naDkEAy7";

test("recordClose moves the position out of state.json into state-closed.json", () => {
  trackPosition({ position: OPEN, pool: POOL, pool_name: "open-SOL", strategy: "bid_ask", amount_sol: 1 });
  trackPosition({ position: CLOSED, pool: POOL, pool_name: "closed-SOL", strategy: "bid_ask", amount_sol: 2,
    deploy_txs: ["deployA"] });
  recordCloseTxAttempt(CLOSED, "closeTx1");
  recordClose(CLOSED, "unit test");

  const state = readState();
  assert.deepEqual(Object.keys(state.positions), [OPEN], "state.json keeps only the open position");
  const closed = readClosed();
  assert.ok(closed.positions[CLOSED], "the closed position landed in the archive");
  assert.equal(closed.positions[CLOSED].closed, true);
  assert.equal(closed.positions[CLOSED].amount_sol, 2);
  assert.ok(state.recentEvents.some((e) => e.action === "close" && e.position === CLOSED),
    "the close event still lands in state.json's recentEvents");
});

test("lookups follow a closed position into the archive", () => {
  assert.equal(getTrackedPosition(CLOSED)?.pool_name, "closed-SOL");
  assert.equal(getTrackedPosition(OPEN)?.pool_name, "open-SOL");
  assert.equal(getTrackedPosition("UNITTESTnobody"), null);
  // closePosition reports the attempt ledger AFTER recordClose — must not go blank.
  assert.deepEqual(getCloseTxAttempts(CLOSED), ["closeTx1"]);
  assert.equal(getTrailingTrace(CLOSED)?.trailing_active, false, "trace still resolves for an archived position");

  assert.deepEqual(getTrackedPositions(true).map((p) => p.position), [OPEN]);
  assert.deepEqual(getTrackedPositions(false).map((p) => p.position).sort(), [CLOSED, OPEN].sort());
  assert.deepEqual(Object.keys(getAllPositionsMap()).sort(), [CLOSED, OPEN].sort());

  const summary = getStateSummary();
  assert.equal(summary.open_positions, 1);
  assert.equal(summary.closed_positions, 1);
});

test("archiveClosedPositions migrates closed entries left in state.json", () => {
  // Pre-archive history: a closed position written straight into state.json.
  const LEGACY = "UNITTESTarchiveLegacy111111111111111111111111";
  const state = readState();
  state.positions[LEGACY] = { position: LEGACY, pool: POOL, pool_name: "legacy-SOL", amount_sol: 3,
    deployed_at: "2026-08-11T05:17:08.294Z", closed: true, closed_at: "2026-08-11T06:00:00.000Z", notes: [] };
  fs.writeFileSync(statePath("state.json"), JSON.stringify(state, null, 2));

  assert.equal(archiveClosedPositions(), 1);
  assert.deepEqual(Object.keys(readState().positions), [OPEN]);
  assert.equal(readClosed().positions[LEGACY]?.pool_name, "legacy-SOL");
  assert.equal(readClosed().positions[CLOSED]?.pool_name, "closed-SOL", "earlier archive entries survive a sweep");
  assert.equal(archiveClosedPositions(), 0, "nothing left to move");
});

test("syncOpenPositions auto-close is archived too", () => {
  const stateFile = statePath("state.json");
  const state = readState();
  state.positions[OPEN].deployed_at = new Date(Date.now() - 30 * 60_000).toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const autoClosed = syncOpenPositions([]);
  assert.deepEqual(autoClosed.map((p) => p.position), [OPEN]);
  assert.deepEqual(Object.keys(readState().positions), []);
  assert.equal(readClosed().positions[OPEN]?.closed, true);
  assert.equal(getTrackedPositions(true).length, 0);
});
