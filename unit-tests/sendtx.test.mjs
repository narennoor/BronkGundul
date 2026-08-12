// sendTx() — the centralized tx submission path (era #9 task 1).
//
// Everything is driven by a mock Connection; no RPC, no wallet, no chain.
// The four behaviours asserted here are the ones era #9 was missing:
//   (a) compute-budget price + limit instructions get prepended,
//   (b) the rebroadcast loop keeps resending until the blockhash dies,
//   (c) the signature survives a confirmation timeout,
//   (d) getSignatureStatus is consulted before a tx is declared failed.

import test from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

process.env.LOG_LEVEL = "error"; // keep the daily log file clean

const { sendTx } = await import("../tools/dlmm.js");

const POOL = "HnNir1tJhkHei2tebBq26CzCN6QXaB2GDnN3naDkEAy7";

function buildTx(payer) {
  const tx = new Transaction();
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey(POOL),
    lamports: 1,
  }));
  return tx;
}

/**
 * @param {object} o
 * @param {"ok"|"timeout"|"err"} o.confirm - how confirmTransaction resolves
 * @param {"landed"|"missing"|"err"} o.status - what getSignatureStatus reports afterwards
 * @param {number} o.blockHeight - constant height returned by getBlockHeight
 */
function mockConnection({ confirm = "ok", status = "missing", pollStatus = "missing", blockHeight = 100, fees = [] } = {}) {
  const calls = { sends: [], statusChecks: 0, polls: 0, blockHeights: 0, feeQueries: 0 };
  return {
    calls,
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 150 };
    },
    async getRecentPrioritizationFees() {
      calls.feeQueries++;
      return fees.map((f, i) => ({ slot: i, prioritizationFee: f }));
    },
    async sendRawTransaction(raw, opts) {
      calls.sends.push({ size: raw.length, skipPreflight: opts?.skipPreflight, maxRetries: opts?.maxRetries });
      return "sent";
    },
    async confirmTransaction() {
      if (confirm === "ok") return { value: { err: null } };
      if (confirm === "err") return { value: { err: { InstructionError: [0, "Custom"] } } };
      return await new Promise(() => {}); // never settles → timeout path
    },
    async getBlockHeight() {
      calls.blockHeights++;
      return blockHeight;
    },
    async getSignatureStatus(_sig, opts) {
      // searchTransactionHistory:false = the in-loop poll that runs alongside
      // confirmTransaction; true = the final rescue check before giving up.
      const mode = opts?.searchTransactionHistory ? status : pollStatus;
      if (opts?.searchTransactionHistory) calls.statusChecks++; else calls.polls++;
      if (mode === "landed") return { value: { err: null, confirmationStatus: "confirmed", confirmations: 3 } };
      if (mode === "processed") return { value: { err: null, confirmationStatus: "processed", confirmations: 0 } };
      if (mode === "err") return { value: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" } };
      return { value: null };
    },
  };
}

const fast = { confirmTimeoutMs: 300, rebroadcastIntervalMs: 50, finalRecheckDelayMs: 10 };

test("(a) prepends ComputeBudget limit + price instructions", async () => {
  const payer = Keypair.generate();
  const tx = buildTx(payer);
  const conn = mockConnection({ fees: [1_000, 20_000, 60_000, 90_000] });

  const sig = await sendTx(tx, [payer], { label: "t", connection: conn, writableAccounts: [POOL], cuLimit: 700_000, ...fast });

  assert.equal(typeof sig, "string");
  const budgetIxs = tx.instructions.filter(
    (ix) => ix.programId.toString() === ComputeBudgetProgram.programId.toString(),
  );
  assert.equal(budgetIxs.length, 2, "both a CU limit and a CU price instruction");
  // They must come FIRST — the runtime only honours a compute budget set before
  // the instruction that needs it.
  assert.equal(tx.instructions[0].programId.toString(), ComputeBudgetProgram.programId.toString());
  assert.equal(tx.instructions[1].programId.toString(), ComputeBudgetProgram.programId.toString());
  assert.equal(conn.calls.feeQueries, 1, "dynamic fee priced against the pool account");
  // p75 of [1k, 20k, 60k, 90k] is 90k, above the 50k floor and under the 1M cap.
  assert.equal(tx.instructions[1].data.readBigUInt64LE(1), 90_000n);
});

test("(a2) an SDK tx that already sets a CU LIMIT still gets a priority fee", async () => {
  // The regression this pins down: every Meteora SDK tx ships its own
  // SetComputeUnitLimit (162 299 on a claim burning 112k CU) and no price. A
  // blanket "already has a compute budget → leave it alone" check skipped the
  // priority fee on every real tx — the first live close after deploy paid
  // 5000 lamports, base fee only.
  const payer = Keypair.generate();
  const tx = buildTx(payer);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 162_299 }));
  const conn = mockConnection({ fees: [40_000, 70_000] });

  await sendTx(tx, [payer], { label: "close_claim", connection: conn, cuLimit: 300_000, ...fast });

  const budgetIxs = tx.instructions.filter(
    (ix) => ix.programId.toString() === ComputeBudgetProgram.programId.toString(),
  );
  assert.equal(budgetIxs.length, 2, "the price instruction must be added on top of the SDK's limit");
  const kinds = budgetIxs.map((ix) => ix.data[0]).sort();
  assert.deepEqual(kinds, [2, 3], "one SetComputeUnitLimit (2) + one SetComputeUnitPrice (3)");
  assert.equal(conn.calls.feeQueries, 1);
  // The SDK's own limit is measured against its own instruction set — keep it.
  const limitIx = budgetIxs.find((ix) => ix.data[0] === 2);
  assert.equal(limitIx.data.readUInt32LE(1), 162_299, "our 300k default must not override the SDK's fitted limit");
});

test("(a3) a tx that already sets a PRICE is left alone", async () => {
  const payer = Keypair.generate();
  const tx = buildTx(payer);
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 111_111 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 }),
  );
  const conn = mockConnection();

  await sendTx(tx, [payer], { label: "t", connection: conn, ...fast });

  const budgetIxs = tx.instructions.filter(
    (ix) => ix.programId.toString() === ComputeBudgetProgram.programId.toString(),
  );
  assert.equal(budgetIxs.length, 2, "nothing added — both kinds already present");
  assert.equal(conn.calls.feeQueries, 0, "no fee lookup when the price is already set");
});

test("(b) rebroadcasts until the blockhash dies, never using RPC-side retries", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", status: "landed", blockHeight: 100 });

  await sendTx(buildTx(payer), [payer], { label: "t", connection: conn, ...fast });

  assert.ok(conn.calls.sends.length >= 3, `expected several sends, got ${conn.calls.sends.length}`);
  assert.equal(conn.calls.sends[0].skipPreflight, false, "first send keeps preflight for readable errors");
  assert.ok(conn.calls.sends.slice(1).every((s) => s.skipPreflight === true), "rebroadcasts skip preflight");
  assert.ok(conn.calls.sends.every((s) => s.maxRetries === 0), "web3.js internal retry disabled");
});

test("(b2) rebroadcasting stops once the block height passes lastValidBlockHeight", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", status: "landed", blockHeight: 999 }); // > 150

  await sendTx(buildTx(payer), [payer], { label: "t", connection: conn, ...fast });

  assert.equal(conn.calls.sends.length, 1, "only the initial send — blockhash was already dead");
  assert.equal(conn.calls.statusChecks, 1, "expiry still triggers the ledger check");
});

test("(c) confirm timeout still returns the signature when the tx actually landed", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", status: "landed" });

  const sig = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast });

  assert.equal(typeof sig, "string");
  assert.ok(sig.length > 40);
  assert.equal(conn.calls.statusChecks, 1);
});

test("(c2) a genuinely expired tx throws WITH its signature attached, after several rechecks", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", status: "missing" });

  const error = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast })
    .then(() => null, (e) => e);

  assert.ok(error, "expected a throw");
  assert.match(error.message, /expired/);
  assert.equal(typeof error.signature, "string", "signature must survive the failure — the cash tracker needs it");
  assert.ok(error.signature.length > 40);
  assert.equal(conn.calls.statusChecks, 4,
    "one status check is not enough — 12 Aug 2026 declared six landed txs expired off a single look");
});

// ── The 12 Aug 2026 expired-but-landed cluster ─────────────────────────────
// Six close_remove txs between 04:01 and 05:34 UTC were declared "expired: no
// confirmation after 6 rebroadcast(s)" while every one of them had landed
// (XST-SOL's landed 03:59:51 and 04:01:16). The RPC's confirmation path was
// degraded, and the OLD final check looked exactly once: a status lookup that
// errored — or ran before the last rebroadcast reached the ledger — read as
// "not landed". Each false expired ghosted a whole cycle from the books
// (−11.07 SOL of phantom loss before recheck-cash corrected it).

test("(e) a status lookup that errors is retried, not read as expired", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout" });
  const poll = conn.getSignatureStatus.bind(conn);
  let historyCalls = 0;
  conn.getSignatureStatus = async (sig, opts) => {
    if (!opts?.searchTransactionHistory) return poll(sig, opts); // in-loop poll: missing
    conn.calls.statusChecks++;
    historyCalls++;
    if (historyCalls <= 2) throw new Error("RPC degraded"); // the 12 Aug condition
    return { value: { err: null, confirmationStatus: "confirmed", confirmations: 1 } };
  };

  const sig = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast });

  assert.equal(typeof sig, "string", "the tx HAD landed — two failed lookups must not become 'expired'");
  assert.equal(conn.calls.statusChecks, 3);
});

test("(e2) a tx still at 'processed' in the final recheck is landed, not expired", async () => {
  // Processed = in a block with no error, confirmations 0. The old predicate
  // required confirmed/finalized/confirmations>0, so a tx checked seconds after
  // its last rebroadcast landed was declared expired.
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", status: "processed" });

  const sig = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast });

  assert.equal(typeof sig, "string");
  assert.equal(conn.calls.statusChecks, 1);
});

test("(e3) a rebroadcast landing seconds after the timeout is caught by a later recheck", async () => {
  // XST-SOL 04:01: the verdict fell at ~04:01, the tx landed 04:01:16.
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout" });
  const poll = conn.getSignatureStatus.bind(conn);
  let historyCalls = 0;
  conn.getSignatureStatus = async (sig, opts) => {
    if (!opts?.searchTransactionHistory) return poll(sig, opts);
    conn.calls.statusChecks++;
    historyCalls++;
    if (historyCalls === 1) return { value: null }; // not in the ledger yet
    return { value: { err: null, confirmationStatus: "confirmed", confirmations: 2 } };
  };

  const sig = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast });

  assert.equal(typeof sig, "string");
  assert.equal(conn.calls.statusChecks, 2);
});

test("(e4) when every status lookup fails, the error says landing was NOT ruled out", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout" });
  const poll = conn.getSignatureStatus.bind(conn);
  conn.getSignatureStatus = async (sig, opts) => {
    if (!opts?.searchTransactionHistory) return poll(sig, opts);
    conn.calls.statusChecks++;
    throw new Error("RPC degraded");
  };

  const error = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast })
    .then(() => null, (e) => e);

  assert.ok(error);
  assert.match(error.message, /landing NOT ruled out/,
    "an operator reading the log must be able to tell 'not in ledger' from 'could not check'");
  assert.equal(typeof error.signature, "string");
  assert.equal(conn.calls.statusChecks, 4, "all rechecks attempted before giving up");
});

test("(d) the ledger is checked before declaring failure, and an on-chain error is reported as such", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", status: "err" });

  const error = await sendTx(buildTx(payer), [payer], { label: "close_remove", connection: conn, ...fast })
    .then(() => null, (e) => e);

  assert.ok(error);
  assert.equal(conn.calls.statusChecks, 1, "getSignatureStatus consulted");
  assert.match(error.message, /failed on-chain/);
  assert.equal(typeof error.signature, "string");
});

test("a dead confirmTransaction subscription does not cost the full timeout", async () => {
  // No WebSocket → confirmTransaction never resolves. The in-loop ledger poll is
  // what keeps every tx from burning txConfirmTimeoutMs.
  const payer = Keypair.generate();
  const conn = mockConnection({ confirm: "timeout", pollStatus: "landed", status: "missing" });

  const started = Date.now();
  const sig = await sendTx(buildTx(payer), [payer], { label: "t", connection: conn, ...fast });

  assert.equal(typeof sig, "string");
  assert.ok(Date.now() - started < 250, "resolved from the poll, not the 300ms timeout");
  assert.equal(conn.calls.statusChecks, 0, "no rescue check needed — the poll already confirmed it");
});

test("preflight rejection surfaces the simulation logs and the signature", async () => {
  const payer = Keypair.generate();
  const conn = mockConnection();
  conn.sendRawTransaction = async (raw, opts) => {
    if (opts?.skipPreflight === false) {
      const e = new Error("Transaction simulation failed");
      e.logs = ["Program log: instruction 1", "Program failed: AccountOwnedByWrongProgram"];
      throw e;
    }
    return "sent";
  };

  const error = await sendTx(buildTx(payer), [payer], { label: "deploy_add 2/2", connection: conn, ...fast })
    .then(() => null, (e) => e);

  assert.ok(error);
  assert.match(error.message, /AccountOwnedByWrongProgram/, "logs must be readable in the error message");
  assert.equal(typeof error.signature, "string");
  assert.deepEqual(error.simulationLogs?.length, 2);
});

test("an RPC failure on the fee lookup falls back to the floor, never to zero", async () => {
  const payer = Keypair.generate();
  const tx = buildTx(payer);
  const conn = mockConnection();
  conn.getRecentPrioritizationFees = async () => { throw new Error("429"); };

  // A different pool than the other tests — the dynamic fee is cached per
  // account set for 15s and would otherwise serve test (a)'s 90k.
  await sendTx(tx, [payer], { label: "t", connection: conn, writableAccounts: [Keypair.generate().publicKey.toString()], ...fast });

  const priceIx = tx.instructions[1];
  assert.equal(priceIx.programId.toString(), ComputeBudgetProgram.programId.toString());
  assert.equal(priceIx.data.readBigUInt64LE(1), 50_000n, "config.tx.priorityFeeFloor");
});
