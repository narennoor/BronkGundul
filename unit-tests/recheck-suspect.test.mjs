// isCashSuspect() — the default (no --positions) filter of recheckCash
// (era #9, incident 12 Aug 2026).
//
// The old inline filter flagged any |inflow − withdrawals| > 1% of deposit.
// But a closed 135-bin position refunds ~0.109 SOL of position-account rent —
// present on virtually every cycle and larger than 1% of a 2-3 SOL deposit —
// so a no-args `--recheck-cash` run considered hundreds of HEALTHY closes
// suspect and set off rescanning all of them. The filter must apply the same
// verdict as the live close path: evaluateCashMismatch, rent allowance
// included. All numbers below are real cycles from lessons.json.

import "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { isCashSuspect } = await import("../pnl-reconciler.js");

test("a normal cycle with the ~0.109 SOL rent refund is NOT suspect", () => {
  // Jimothy-SOL, 12 Aug 2026 — a perfectly healthy close: cash_complete on the
  // live path, surplus exactly one position-account rent.
  const entry = {
    deposits_sol: 2.0699965679999996,
    withdrawals_sol: 2.0698124028899123,
    exit_execution: {
      sol_in_close: 2.170793345,
      sol_in_swap: 0.008172867,
      cash_complete: true,
    },
  };

  // Pin the regression: the OLD filter's own arithmetic flags this cycle...
  const inflow = 2.170793345 + 0.008172867;
  assert.ok(Math.abs(inflow - entry.withdrawals_sol) > entry.deposits_sol * 0.01,
    "the rent refund exceeds 1% of the deposit — exactly why the old filter rescanned everything");
  // ...the new one does not.
  assert.equal(isCashSuspect(entry), false,
    "a rent-sized surplus is normal, not a reason to rescan the position");
});

test("a phantom-loss cycle (close signatures missing) IS suspect", () => {
  // BUTTHOLE-SOL 04:58 12 Aug, pre-recheck books: close tx declared expired but
  // landed, ledger saw only the swap dust come back. Booked −2.098 SOL against
  // a wallet that ended the cycle +0.001.
  const entry = {
    deposits_sol: 1.98999076,
    withdrawals_sol: 1.989989704,
    exit_execution: {
      sol_in_close: 0,
      sol_in_swap: 0.001245941,
      cash_complete: true, // the pre-fix-1.3 books even called themselves complete
    },
  };
  assert.equal(isCashSuspect(entry), true, "a shortfall the size of the whole deposit must be rescanned");
});

test("a surplus larger than rent can explain IS suspect", () => {
  // LOUIE-SOL 11 Aug, pre-recheck books: +0.28660419 SOL surplus — beyond the
  // 1% tolerance + 0.25 rent allowance. The live path flagged it; the rescan
  // later proved the figure right (multi-position rent), but flagging it for a
  // look was correct.
  const entry = {
    deposits_sol: 2.71999252,
    withdrawals_sol: 1.4451704194844723,
    exit_execution: {
      sol_in_close: 0.108795424,
      sol_in_swap: 1.622979185,
      cash_complete: true,
    },
  };
  assert.equal(isCashSuspect(entry), true);
});

test("a close already verified by a COMPLETE position-account scan is final — never rescanned", () => {
  // LOUIE-SOL after its 12 Aug recheck: the Meteora cross-check still reads a
  // surplus beyond one rent refund (inflow 1.943 vs withdrawals 1.445), but the
  // position-account scan verified the figure to the lamport (8 tx, delta 0).
  // Rescanning it returns the identical answer, so a default run must skip it.
  const entry = {
    deposits_sol: 2.71999252,
    withdrawals_sol: 1.4451704194844723,
    exit_execution: {
      sol_in_close: 0.320074257,
      sol_in_swap: 1.622979185,
      cash_complete: true,
      cash_source: "recheck-cash (position-account scan)",
    },
  };
  assert.equal(isCashSuspect(entry), false);
});

test("cash_complete:false is always suspect, whatever the arithmetic says", () => {
  // The shape the sync-auto-close path writes before its position-account scan
  // lands: no cash figures at all yet, withdrawals unknown.
  const entry = {
    deposits_sol: null,
    withdrawals_sol: null,
    exit_execution: {
      cash_complete: false,
      cash_source: "state-sync auto-close (pending position-account scan)",
    },
  };
  assert.equal(isCashSuspect(entry), true,
    "a pending sync-close entry must be picked up by the very next recheck run");
});

test("no Meteora figure and complete books → not suspect", () => {
  // XST-SOL 04:02 12 Aug after its manual backfill: withdrawals_sol is null
  // (datapi never indexed the cycle) but the position-account scan already
  // filled the cash. A default recheck run must leave it alone.
  const entry = {
    deposits_sol: null,
    withdrawals_sol: null,
    amount_sol: 2.43,
    exit_execution: {
      sol_in_close: 2.538790301,
      sol_in_swap: 0,
      sol_cycle_net: -0.000238855,
      cash_complete: true,
      cash_source: "recheck-cash (position-account scan)",
    },
  };
  assert.equal(isCashSuspect(entry), false);
});
