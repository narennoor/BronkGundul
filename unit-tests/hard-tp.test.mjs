// Hard take-profit ceiling fast-path (era #10 GUNICORN incident).
//
// The mechanism these tests pin down: on 16 Aug 2026 a trusted tick hit
// +38.21% on GUNICORN-SOL, trailing armed at that peak, and ~6s later the
// next evaluated tick was -16.16% (final -0.2506 SOL). Every existing exit
// path needs more than one tick — trailing needs a later drop tick, RULE_2
// take-profit needs a confirm streak plus a 15s hold. hardTakeProfitPct
// closes on the single trusted tick that crosses the ceiling: HARD_TP wins
// before trailing in updatePnlAndCheckExits, and the poller registers it
// with confirmTicks=1 so registerExitSignal fires immediately.
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

const { trackPosition, confirmPeak, updatePnlAndCheckExits, registerExitSignal } = await import("../state.js");

// Era #10 management config, trimmed to what the exit rules read.
const ERA10 = {
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1.5,
  trailingBreakevenFloorPct: null,
  hardTakeProfitPct: null,
  stopLossPct: null,
  outOfRangeWaitMinutes: 15,
  minFeePerTvl24h: 1,
  minAgeBeforeYieldCheck: 60,
};

let n = 0;
function freshPosition() {
  const address = `UNITTESThardtp${String(++n).padStart(29, "0")}`;
  trackPosition({
    position: address,
    pool: "3W2HKuUyYyPvhUyTLcpTVwrjfnRUqjwjcVKPT6X8CH3g",
    pool_name: "GUNICORN-SOL",
    strategy: "bid_ask",
    amount_sol: 1.5,
  });
  return address;
}

// One poller tick: confirm the peak (as index.js does), then evaluate exits.
function tick(address, pnlPct, cfg = ERA10) {
  confirmPeak(address, pnlPct, 1);
  return updatePnlAndCheckExits(address, { pnl_pct: pnlPct, in_range: true, fee_per_tvl_24h: 5, age_minutes: 30 }, cfg);
}

test.after(() => {
  if (backup) fs.writeFileSync(STATE_FILE, backup);
  else if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
});

test("hard TP is OFF by default (null) — a huge spike arms trailing but does not exit", () => {
  const pos = freshPosition();
  const exit = tick(pos, 38.21);
  assert.equal(exit, null, "with the ceiling off, the spike tick itself must not close");
});

test("hardTakeProfitPct 0 also disables the rule", () => {
  const cfg = { ...ERA10, hardTakeProfitPct: 0 };
  const pos = freshPosition();
  assert.equal(tick(pos, 12, cfg), null);
});

test("a single trusted tick at/above the ceiling fires HARD_TP with a distinct reason", () => {
  const cfg = { ...ERA10, hardTakeProfitPct: 10 };
  const pos = freshPosition();
  const exit = tick(pos, 10, cfg); // "at" — the comparison is >=
  assert.ok(exit, "must fire on the very first qualifying tick");
  assert.equal(exit.action, "HARD_TP");
  assert.equal(exit.hard_take_profit, true);
  assert.match(exit.reason, /^hard take profit: \+10\.00% >= 10%$/, "lessons.js buckets by this string");
  assert.equal(exit.current_pnl_pct, 10);
});

test("below the ceiling nothing fires", () => {
  const cfg = { ...ERA10, hardTakeProfitPct: 10 };
  const pos = freshPosition();
  assert.equal(tick(pos, 2.9, cfg), null, "below trailing trigger too");
  assert.equal(tick(pos, 9.99, cfg), null, "armed trailing, but no drop and no ceiling hit");
});

test("GUNICORN replay: the spike tick closes at +38.21 instead of trailing out at -16.16", () => {
  const cfg = { ...ERA10, hardTakeProfitPct: 10 };
  const pos = freshPosition();
  tick(pos, 1.1, cfg);
  const spike = tick(pos, 38.21, cfg);
  assert.equal(spike.action, "HARD_TP", "the +38.21% tick itself is the exit");
  assert.match(spike.reason, /\+38\.21% >= 10%/);

  // Old behaviour for contrast: with the ceiling off, the same sequence only
  // exits on the NEXT tick, via trailing, deep in the red.
  const pos2 = freshPosition();
  tick(pos2, 1.1);
  assert.equal(tick(pos2, 38.21), null, "trailing arms at the peak — no exit on the spike tick");
  const late = tick(pos2, -16.16);
  assert.equal(late.action, "TRAILING_TP");
  assert.ok(late.current_pnl_pct < 0, "the trailing path realises the collapse, not the peak");
});

test("a suspicious tick never triggers hard TP (JLY 5 Aug phantom-PnL guard)", () => {
  const cfg = { ...ERA10, hardTakeProfitPct: 10 };
  const pos = freshPosition();
  const exit = updatePnlAndCheckExits(pos, { pnl_pct: 44.4, pnl_pct_suspicious: true, in_range: true }, cfg);
  assert.equal(exit, null, "phantom deposit-indexing spikes must not close positions");
});

test("HARD_TP wins over an armed trailing exit on the same tick", () => {
  // Armed at a high peak, then a tick that satisfies BOTH the trailing drop and
  // the ceiling: the hard rule must claim it so the close reason buckets apart.
  const cfg = { ...ERA10, hardTakeProfitPct: 10 };
  const pos = freshPosition();
  tick(pos, 20); // arm trailing at peak 20 with the ceiling off (ERA10 default)
  const exit = tick(pos, 12, cfg); // drop 8 >= 1.5 AND 12 >= 10
  assert.equal(exit.action, "HARD_TP");
});

test("stop loss still evaluates before the hard ceiling", () => {
  const cfg = { ...ERA10, hardTakeProfitPct: 10, stopLossPct: -8 };
  const pos = freshPosition();
  const exit = tick(pos, -9, cfg);
  assert.equal(exit.action, "STOP_LOSS");
});

test("registerExitSignal with confirmTicks=1 fires on the first tick (the poller's HARD_TP wiring)", () => {
  const pos = freshPosition();
  const { fire, count } = registerExitSignal(pos, "HARD_TP", 1, 0);
  assert.equal(fire, true, "no streak, no hold — one tick closes");
  assert.equal(count, 1);

  // The regular wiring for contrast: confirmTicks=2 needs a second tick.
  const pos2 = freshPosition();
  assert.equal(registerExitSignal(pos2, "TRAILING_TP", 2, 0).fire, false);
  assert.equal(registerExitSignal(pos2, "TRAILING_TP", 2, 0).fire, true);
});
