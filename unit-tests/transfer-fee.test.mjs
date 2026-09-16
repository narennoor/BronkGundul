// Token-2022 transfer-fee screening filter (NEARKAT-SOL, 16 Sep 2026).
//
// The mint carried transferFeeBasisPoints 300. Meteora booked the close at
// +1.90% (withdrawals + fees GROSS of the fee); the wallet netted +0.74%
// because the token leg paid 3% leaving the pool and 3% again entering the
// Jupiter swap. The fee is readable from the mint account before deploy —
// these tests pin the parser, the verdict, and the batched/cached lookup.

import "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";

process.env.LOG_LEVEL = "error";

const {
  parseTransferFeeBps,
  transferFeeRejectReason,
  getTransferFeeBps,
  TOKEN_2022_PROGRAM_ID,
  _resetTransferFeeCache,
} = await import("../tools/transfer-fee.js");

const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// jsonParsed shape as returned by getMultipleParsedAccounts for NEARKAT on 16 Sep 2026
const nearkat = {
  owner: TOKEN_2022_PROGRAM_ID,
  data: {
    parsed: {
      type: "mint",
      info: {
        decimals: 6,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              newerTransferFee: { epoch: 1029, maximumFee: 1000000000000000, transferFeeBasisPoints: 300 },
              olderTransferFee: { epoch: 1029, maximumFee: 1000000000000000, transferFeeBasisPoints: 300 },
              withheldAmount: 406967661107,
            },
          },
        ],
      },
    },
  },
};

test("NEARKAT: Token-2022 transferFeeConfig → 300 bps", () => {
  assert.deepEqual(parseTransferFeeBps(nearkat, 1100), { bps: 300, program: "token-2022" });
});

test("plain SPL token mint → 0 bps, never reads extensions", () => {
  assert.deepEqual(parseTransferFeeBps({ owner: SPL_TOKEN, data: { parsed: { info: {} } } }), { bps: 0, program: "spl-token" });
});

test("Token-2022 mint without the extension → 0 bps", () => {
  const acc = { owner: TOKEN_2022_PROGRAM_ID, data: { parsed: { info: { extensions: [{ extension: "metadataPointer" }] } } } };
  assert.deepEqual(parseTransferFeeBps(acc), { bps: 0, program: "token-2022" });
});

test("scheduled fee change: older applies until the newer epoch is reached", () => {
  const acc = {
    owner: TOKEN_2022_PROGRAM_ID,
    data: { parsed: { info: { extensions: [{
      extension: "transferFeeConfig",
      state: { newerTransferFee: { epoch: 1200, transferFeeBasisPoints: 500 }, olderTransferFee: { epoch: 1000, transferFeeBasisPoints: 100 } },
    }] } } },
  };
  assert.equal(parseTransferFeeBps(acc, 1199).bps, 100);
  assert.equal(parseTransferFeeBps(acc, 1200).bps, 500);
  assert.equal(parseTransferFeeBps(acc, null).bps, 500, "unknown epoch → newer (conservative)");
});

test("missing / unparseable account → null (caller decides fail-open vs fail-closed)", () => {
  assert.equal(parseTransferFeeBps(null), null);
  assert.equal(parseTransferFeeBps({ owner: TOKEN_2022_PROGRAM_ID, data: "base64junk" }), null);
});

test("verdict: 0 = only fee-free tokens, null = filter off, unknown bps passes", () => {
  assert.equal(transferFeeRejectReason(0, 0), null);
  assert.match(transferFeeRejectReason(300, 0), /transfer fee 300 bps above maxTransferFeeBps 0/);
  assert.equal(transferFeeRejectReason(300, 300), null);
  assert.match(transferFeeRejectReason(301, 300), /above maxTransferFeeBps 300/);
  assert.equal(transferFeeRejectReason(300, null), null, "null disables the filter");
  assert.equal(transferFeeRejectReason(null, 0), null, "unknown bps is the caller's policy");
});

function fakeConnection(accountsByMint, calls) {
  return {
    async getEpochInfo() { return { epoch: 1100 }; },
    async getMultipleParsedAccounts(keys) {
      calls.push(keys.map(String));
      return { value: keys.map((k) => accountsByMint[String(k)] ?? null) };
    },
  };
}

test("lookup: one batched RPC call, results keyed by mint, cache hit on the second call", async () => {
  _resetTransferFeeCache();
  const calls = [];
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const nkat = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
  const conn = fakeConnection({ [usdc]: { owner: SPL_TOKEN, data: { parsed: { info: {} } } }, [nkat]: nearkat }, calls);

  const first = await getTransferFeeBps([usdc, nkat, nkat], { connection: conn });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [usdc, nkat], "deduped, single batch");
  assert.equal(first.get(usdc).bps, 0);
  assert.equal(first.get(nkat).bps, 300);

  const second = await getTransferFeeBps([nkat], { connection: conn });
  assert.equal(calls.length, 1, "served from cache");
  assert.equal(second.get(nkat).bps, 300);

  await getTransferFeeBps([nkat], { connection: conn, force: true });
  assert.equal(calls.length, 2, "force bypasses the cache");
});

test("lookup: RPC failure → null for every mint in the batch, nothing cached", async () => {
  _resetTransferFeeCache();
  const mint = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
  const failing = {
    async getEpochInfo() { throw new Error("429"); },
    async getMultipleParsedAccounts() { throw new Error("429 Too Many Requests"); },
  };
  const res = await getTransferFeeBps([mint], { connection: failing });
  assert.equal(res.get(mint), null);
  const calls = [];
  const ok = fakeConnection({ [mint]: nearkat }, calls);
  const again = await getTransferFeeBps([mint], { connection: ok });
  assert.equal(calls.length, 1, "a failed lookup must not be cached");
  assert.equal(again.get(mint).bps, 300);
});
