// Partially-indexed deposit guard (phantom-PnL close, MEOW-SOL 16 Aug 2026).
//
// The mechanism these tests pin down: a multi-tx deploy indexes into the
// datapi one tx at a time, and until every chunk lands the indexed deposit
// total understates the cost basis, so the tick reads as a phantom profit.
// The MEOW-SOL incident deployed 1.81 SOL in chunks of 1.6357 + 0.1743; with
// only the first chunk indexed (ratio 90.4%) the old 0.9 threshold trusted
// the tick, the phantom +10.66% armed the trailing TP, and the position was
// closed 31s after deploy for an actual PnL of -0.01%.

import test from "node:test";
import assert from "node:assert/strict";

process.env.LOG_LEVEL = "error";

const { isDepositPartiallyIndexed, DEPOSIT_COMPLETE_MIN_RATIO } = await import("../tools/pnl.js");

const entry = (sol) => ({ allTimeDeposits: { total: { sol } } });

test("threshold is tight enough to catch a missing ≤10% chunk", () => {
  assert.ok(DEPOSIT_COMPLETE_MIN_RATIO >= 0.99);
});

test("MEOW-SOL 16 Aug: first chunk alone (1.6357 of 1.81) is flagged partial", () => {
  assert.equal(isDepositPartiallyIndexed(entry(1.6357), 1.81), true);
});

test("fully indexed deposit is not flagged", () => {
  assert.equal(isDepositPartiallyIndexed(entry(1.81), 1.81), false);
});

test("float rounding within tolerance is not flagged", () => {
  assert.equal(isDepositPartiallyIndexed(entry(1.8099999), 1.81), false);
});

test("zero indexed deposit is left to the depositsMissing gate", () => {
  assert.equal(isDepositPartiallyIndexed(entry(0), 1.81), false);
});

test("untracked position (no expected amount) is never flagged", () => {
  assert.equal(isDepositPartiallyIndexed(entry(1.6357), undefined), false);
  assert.equal(isDepositPartiallyIndexed(entry(1.6357), 0), false);
});
