// Close-signature accumulation + the Meteora cash cross-check (era #9 task 2).
//
// Reproduces the 7-10 Aug failure with no chain involved: a 3-tx close whose
// 2nd tx times out used to lose the signatures of the txs that had already
// landed, so the cash reconciliation measured ~26% of the deposit coming back,
// called itself complete, and booked a multi-SOL loss that never happened.
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

const { trackPosition, recordCloseTxAttempt, getCloseTxAttempts } = await import("../state.js");
const { evaluateCashMismatch } = await import("../tools/wallet.js");

const POS = "UNITTESTclose1111111111111111111111111111111";

test.after(() => {
  if (backup) fs.writeFileSync(STATE_FILE, backup);
  else if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
});

test("a 3-tx close whose 2nd tx times out keeps ALL three signatures", () => {
  trackPosition({
    position: POS,
    pool: "HnNir1tJhkHei2tebBq26CzCN6QXaB2GDnN3naDkEAy7",
    pool_name: "three-SOL",
    strategy: "bid_ask",
    amount_sol: 4.0689,
    deploy_txs: ["deploy1", "deploy2", "deploy3"],
  });

  // ── Attempt 1: tx 1 lands, tx 2 times out and throws ──
  recordCloseTxAttempt(POS, "closeTx1");
  const timeoutError = Object.assign(new Error("close_remove 2/3 expired"), { signature: "closeTx2" });
  // This is what sendClosePathTx does on the failure path before rethrowing.
  recordCloseTxAttempt(POS, timeoutError.signature);

  assert.deepEqual(getCloseTxAttempts(POS), ["closeTx1", "closeTx2"],
    "the landed tx must not disappear with the exception");

  // ── Attempt 2: the retry only knows about its own signature ──
  const retryResult = { success: true, close_txs: ["closeTx3"] };
  recordCloseTxAttempt(POS, "closeTx3");

  // What the executor now hands to reconcileCycleCash.
  const union = [...new Set([...(retryResult.close_txs || []), ...getCloseTxAttempts(POS)])];
  assert.deepEqual(union.sort(), ["closeTx1", "closeTx2", "closeTx3"],
    "reconciliation must see every signature ever submitted, not just the retry's");
});

test("attempts are deduplicated and survive repeated recording", () => {
  recordCloseTxAttempt(POS, "closeTx1");
  recordCloseTxAttempt(POS, "closeTx3");
  recordCloseTxAttempt(POS, null);
  assert.deepEqual(getCloseTxAttempts(POS), ["closeTx1", "closeTx2", "closeTx3"]);
});

test("the Meteora cross-check catches the three-SOL hole (7 Aug)", () => {
  // Real numbers: deposited 4.0689 SOL, our ledger saw only 1.0423 SOL come
  // back, Meteora recorded a 3.9599 SOL withdrawal. sol_cycle_net was booked at
  // -3.0202 SOL against a wallet that actually ended the cycle +0.0001.
  const verdict = evaluateCashMismatch({
    inflowSol: 1.0423,
    withdrawalsSol: 3.9599,
    depositBasisSol: 4.0689,
    tolerancePct: 1,
  });
  assert.equal(verdict.mismatch_sol, -2.9176);
  assert.equal(verdict.over_tolerance, true, "cash_complete must become false, not true");
});

test("an ordinary close with swap slippage stays inside tolerance", () => {
  // Withdraw 2.0 SOL of value, get 1.995 back after the Jupiter leg — 0.25% of
  // the deposit, well under the 1% bar.
  const verdict = evaluateCashMismatch({
    inflowSol: 1.995,
    withdrawalsSol: 2.0,
    depositBasisSol: 2.0,
    tolerancePct: 1,
  });
  assert.equal(verdict.over_tolerance, false);
  assert.equal(verdict.tolerance_sol, 0.02);
});

test("no Meteora figure available → no verdict, never a false alarm", () => {
  assert.deepEqual(
    evaluateCashMismatch({ inflowSol: 1, withdrawalsSol: null, depositBasisSol: 2 }),
    { mismatch_sol: null, over_tolerance: false, tolerance_sol: null },
  );
  assert.equal(evaluateCashMismatch({ inflowSol: 1, withdrawalsSol: 2, depositBasisSol: 0 }).over_tolerance, false);
});
