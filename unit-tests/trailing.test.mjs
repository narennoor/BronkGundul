// Trailing-exit instrumentation + breakeven floor (era #9 task 3).
//
// The mechanism these tests pin down: trailing arms exactly AT the confirmed
// peak, so the drop-from-peak test can only ever be evaluated on a LATER tick.
// When a dump clears trailingDropPct inside one poll interval the exit fires far
// past the threshold — 4 of 14 era #9 trailing closes overshot by 0.7-3.9pp.
// The trace makes that measurable and the floor makes it bounded.
//
// state.json is backed up byte-for-byte and restored in a finally.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

process.env.LOG_LEVEL = "error";

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "state.json");
const backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : null;

const { trackPosition, confirmPeak, updatePnlAndCheckExits, getTrailingTrace } = await import("../state.js");

// Era #9 management config, trimmed to what the exit rules read.
const ERA9 = {
  trailingTakeProfit: true,
  trailingTriggerPct: 1.2,
  trailingDropPct: 0.8,
  trailingBreakevenFloorPct: null,
  stopLossPct: null,
  outOfRangeWaitMinutes: 15,
  minFeePerTvl24h: 1,
  minAgeBeforeYieldCheck: 60,
};

let n = 0;
function freshPosition() {
  const address = `UNITTESTtrail${String(++n).padStart(30, "0")}`;
  trackPosition({
    position: address,
    pool: "HnNir1tJhkHei2tebBq26CzCN6QXaB2GDnN3naDkEAy7",
    pool_name: "Frohorse-SOL",
    strategy: "bid_ask",
    amount_sol: 2.5,
  });
  return address;
}

// One poller tick: confirm the peak (as index.js does), then evaluate exits.
function tick(address, pnlPct, cfg = ERA9) {
  confirmPeak(address, pnlPct, 1);
  return updatePnlAndCheckExits(address, { pnl_pct: pnlPct, in_range: true, fee_per_tvl_24h: 5, age_minutes: 30 }, cfg);
}

test.after(() => {
  if (backup) fs.writeFileSync(STATE_FILE, backup);
  else if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
});

test("the tick trace records every trusted sample and the gap between them", () => {
  const pos = freshPosition();
  tick(pos, 0.4);
  tick(pos, 0.9);
  tick(pos, 1.3);

  const trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_sample_count, 3);
  assert.deepEqual(trace.trailing_samples.map((s) => s.p), [0.4, 0.9, 1.3]);
  assert.equal(typeof trace.ms_since_prev_sample, "number");
  assert.ok(trace.ms_since_prev_sample >= 0);
});

test("a suspicious tick never enters the trace (same rule as peak tracking)", () => {
  const pos = freshPosition();
  tick(pos, 1.3); // arms trailing, so the sample tail is persisted
  updatePnlAndCheckExits(pos, { pnl_pct: 31.2, pnl_pct_suspicious: true, in_range: true }, ERA9);

  const trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_sample_count, 1, "the phantom-PnL spike must not be recorded");
  assert.deepEqual(trace.trailing_samples.map((s) => s.p), [1.3]);
});

test("a close that never armed trailing carries no sample payload", () => {
  const pos = freshPosition();
  tick(pos, 0.4);
  tick(pos, 0.7);

  const trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_active, false);
  assert.deepEqual(trace.trailing_samples, [], "keeps lessons.json lean — nothing to explain here");
  assert.equal(trace.trailing_sample_count, 2, "the buffer itself still exists in state");
});

test("trailing arms at the peak and stamps trailing_armed_at", () => {
  const pos = freshPosition();
  assert.equal(tick(pos, 0.9), null, "below the 1.2% trigger");
  let trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_active, false);

  tick(pos, 1.38);
  trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_active, true);
  assert.equal(trace.trailing_armed_peak_pct, 1.38);
  assert.ok(trace.trailing_armed_at);
});

test("Frohorse replay: the overshoot is measured, not hidden", () => {
  // 8 Aug 18:17 UTC — peak confirmed at 2.55%, the very next evaluated tick was
  // already -2.11%. The 0.8% drop level was never observable.
  const pos = freshPosition();
  tick(pos, 0.09);
  tick(pos, 2.55);            // spike → peak confirmed → trailing armed
  const exit = tick(pos, -2.11);

  assert.equal(exit.action, "TRAILING_TP");
  assert.equal(Math.round(exit.drop_from_peak_pct * 100) / 100, 4.66);

  const trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_peak_pct, 2.55);
  assert.equal(trace.trailing_exit_pnl_pct, -2.11);
  assert.equal(trace.trailing_drop_observed_pct, 4.66);
  assert.equal(trace.trailing_overshoot_pct, 3.86, "3.86pp past where the rule said to exit");
  assert.ok(trace.ms_armed_to_exit >= 0);
});

test("a healthy trailing close shows ~zero overshoot", () => {
  // TOAD-SOL 9 Aug: peak 1.28%, exited at 0.43% — drop 0.85 vs a 0.8 threshold.
  const pos = freshPosition();
  tick(pos, 1.28);
  const exit = tick(pos, 0.43);

  assert.equal(exit.action, "TRAILING_TP");
  const trace = getTrailingTrace(pos, ERA9.trailingDropPct);
  assert.equal(trace.trailing_overshoot_pct, 0.05);
});

test("breakeven floor is OFF by default — behaviour is unchanged", () => {
  const pos = freshPosition();
  tick(pos, 1.3);              // arms
  const exit = tick(pos, 0.2); // drop 1.1 ≥ 0.8 → the ordinary rule fires
  assert.equal(exit.action, "TRAILING_TP");
  assert.match(exit.reason, /dropped/, "the ordinary drop rule, not the floor");

  const pos2 = freshPosition();
  tick(pos2, 1.3);
  const held = tick(pos2, 0.6); // drop 0.7 < 0.8 → no exit while the floor is off
  assert.equal(held, null);
});

test("breakeven floor closes an armed position before it turns into a loss", () => {
  const withFloor = { ...ERA9, trailingBreakevenFloorPct: 0.7 };
  const pos = freshPosition();
  tick(pos, 1.3, withFloor);            // arms
  const exit = tick(pos, 0.6, withFloor); // drop only 0.7 — the drop rule would NOT fire

  assert.ok(exit, "the floor must fire where the drop rule does not");
  assert.equal(exit.action, "TRAILING_TP");
  assert.equal(exit.breakeven_floor, true);
  assert.match(exit.reason, /breakeven floor/);
  assert.equal(exit.needs_confirmation, true, "still confirmation-gated, like every other exit");
});

test("the floor never fires on a position that never armed trailing", () => {
  const withFloor = { ...ERA9, trailingBreakevenFloorPct: 0 };
  const pos = freshPosition();
  assert.equal(tick(pos, 0.5, withFloor), null);
  assert.equal(tick(pos, -0.4, withFloor), null, "never reached the 1.2% trigger");
});

test("the floor never fires on a suspicious tick", () => {
  const withFloor = { ...ERA9, trailingBreakevenFloorPct: 0 };
  const pos = freshPosition();
  tick(pos, 1.3, withFloor);
  const exit = updatePnlAndCheckExits(pos, { pnl_pct: -5, pnl_pct_suspicious: true, in_range: true }, withFloor);
  assert.equal(exit, null);
});
