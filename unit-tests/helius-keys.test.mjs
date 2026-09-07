// unit-tests/helius-keys.test.mjs — Helius key ring + fallback.
// Fully offline: globalThis.fetch is stubbed per test.
import "./_setup.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.HELIUS_API_KEY = "primary-key";
process.env.HELIUS_API_KEY_BACKUP = "backup-key";
process.env.RPC_URL = "https://mainnet.helius-rpc.com/?api-key=primary-key";
process.env.HELIUS_KEY_COOLDOWN_MIN = "30";

const {
  heliusKeyRing,
  activeHeliusKey,
  markHeliusKeyLimited,
  isKeyLimited,
  resetHeliusKeyState,
  heliusFetch,
  rpcFetch,
  rpcUrlForKey,
  activeRpcUrl,
  rpcConnectionKey,
} = await import("../utils/helius-keys.js");
const { fetchTxPage, fetchAllTxs, fetchBalance } = await import("../utils/chain-flows.js");

const origFetch = globalThis.fetch;
function res(status, body = "", headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body || "null"),
    clone() { return res(status, body, headers); },
  };
}
const keyOf = (url) => new URL(String(url)).searchParams.get("api-key");

beforeEach(() => {
  resetHeliusKeyState();
  globalThis.fetch = origFetch;
});

test("ring order: primary, backup, extras — de-duplicated", () => {
  process.env.HELIUS_API_KEYS = "extra-1, primary-key ,extra-2";
  try {
    assert.deepEqual(heliusKeyRing(), ["primary-key", "backup-key", "extra-1", "extra-2"]);
  } finally {
    delete process.env.HELIUS_API_KEYS;
  }
  assert.equal(activeHeliusKey(), "primary-key");
});

test("a limited primary yields the backup until the cooldown expires, then the primary again", () => {
  const t0 = 1_000_000;
  assert.equal(markHeliusKeyLimited("primary-key", {}, t0), "backup-key");
  assert.equal(isKeyLimited("primary-key", t0 + 1), true);
  assert.equal(activeHeliusKey(t0 + 1), "backup-key");
  assert.equal(activeHeliusKey(t0 + 30 * 60_000 - 1), "backup-key");
  assert.equal(activeHeliusKey(t0 + 30 * 60_000), "primary-key");
});

test("Retry-After longer than the cooldown extends the park", () => {
  const t0 = 5_000;
  markHeliusKeyLimited("primary-key", { retryAfterSec: 3600 }, t0);
  assert.equal(activeHeliusKey(t0 + 31 * 60_000), "backup-key");
  assert.equal(activeHeliusKey(t0 + 3600 * 1000), "primary-key");
});

test("all keys limited: pick the one whose cooldown ends first", () => {
  markHeliusKeyLimited("primary-key", {}, 1000);
  markHeliusKeyLimited("backup-key", {}, 2000);
  assert.equal(activeHeliusKey(3000), "primary-key");
});

test("heliusFetch: 429 on the primary retries once on the backup and returns its response", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(keyOf(url));
    return keyOf(url) === "primary-key" ? res(429, "max usage reached") : res(200, '{"ok":1}');
  };
  const r = await heliusFetch((key) => `https://api.helius.xyz/v1/wallet/W/balances?api-key=${key}`);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ["primary-key", "backup-key"]);
  // subsequent calls go straight to the backup — no primary probe inside the cooldown
  calls.length = 0;
  await heliusFetch((key) => `https://api.helius.xyz/v1/x?api-key=${key}`);
  assert.deepEqual(calls, ["backup-key"]);
});

test("heliusFetch: a 401 is NOT rotated — misconfiguration stays loud", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(keyOf(url)); return res(401, "Unauthorized"); };
  const r = await heliusFetch((key) => `https://api.helius.xyz/v1/x?api-key=${key}`);
  assert.equal(r.status, 401);
  assert.deepEqual(calls, ["primary-key"]);
  assert.equal(activeHeliusKey(), "primary-key");
});

test("heliusFetch: a non-429 quota body (403 'credits exhausted') also rotates", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(keyOf(url));
    return keyOf(url) === "primary-key" ? res(403, '{"error":"credits exhausted for this plan"}') : res(200, "{}");
  };
  const r = await heliusFetch((key) => `https://api.helius.xyz/v1/x?api-key=${key}`);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ["primary-key", "backup-key"]);
});

test("heliusFetch: every key limited → the last 429 is returned, each key tried once", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(keyOf(url)); return res(429, ""); };
  const r = await heliusFetch((key) => `https://api.helius.xyz/v1/x?api-key=${key}`);
  assert.equal(r.status, 429);
  assert.deepEqual(calls, ["primary-key", "backup-key"]);
});

test("rpcUrlForKey / activeRpcUrl: RPC_URL re-keyed for the backup, RPC_URL_BACKUP wins when set", () => {
  assert.equal(rpcUrlForKey("primary-key"), process.env.RPC_URL);
  assert.equal(rpcUrlForKey("backup-key"), "https://mainnet.helius-rpc.com/?api-key=backup-key");
  const before = rpcConnectionKey();
  markHeliusKeyLimited("primary-key");
  assert.equal(activeRpcUrl(), "https://mainnet.helius-rpc.com/?api-key=backup-key");
  assert.notEqual(rpcConnectionKey(), before);
  process.env.RPC_URL_BACKUP = "https://other.example/?api-key=backup-key";
  try {
    assert.equal(activeRpcUrl(), process.env.RPC_URL_BACKUP);
  } finally {
    delete process.env.RPC_URL_BACKUP;
  }
});

test("rpcFetch (web3.js Connection fetch): swaps the RPC api-key on 429, passes non-Helius URLs through", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init?.body]);
    return keyOf(url) === "primary-key" ? res(429, "") : res(200, '{"jsonrpc":"2.0","result":1}');
  };
  const init = { method: "POST", body: '{"method":"getBalance"}' };
  const r = await rpcFetch(process.env.RPC_URL, init);
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map(([u]) => keyOf(u)), ["primary-key", "backup-key"]);
  assert.ok(calls.every(([, body]) => body === init.body), "the JSON-RPC body is re-sent unchanged");

  calls.length = 0;
  globalThis.fetch = async (url) => { calls.push([String(url)]); return res(200, "{}"); };
  await rpcFetch("https://pump.helius-rpc.com", init);
  assert.deepEqual(calls, [["https://pump.helius-rpc.com"]]);
});

test("fetchTxPage with a URL builder rotates before backing off; a plain string never rotates", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(keyOf(url));
    return keyOf(url) === "primary-key" ? res(429, "") : res(200, "[]");
  };
  const t = Date.now();
  const { batch, throttled } = await fetchTxPage((key) => `https://api.helius.xyz/v0/addresses/W/transactions?api-key=${key}`);
  assert.deepEqual(batch, []);
  assert.equal(throttled, false, "the rotated request succeeded on attempt 0 — no backoff sleep");
  assert.ok(Date.now() - t < 500);
  assert.deepEqual(calls, ["primary-key", "backup-key"]);
});

test("fetchAllTxs: pages keep flowing on the backup key after the primary hits 429 mid-walk", async () => {
  const calls = [];
  const page1 = JSON.stringify([{ signature: "s1", timestamp: 200 }, { signature: "s2", timestamp: 190 }]);
  const page2 = JSON.stringify([{ signature: "s3", timestamp: 50 }]);
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push([keyOf(u), u.searchParams.get("before")]);
    if (!u.searchParams.get("before")) return res(200, page1);
    return keyOf(u) === "primary-key" ? res(429, "max usage reached") : res(200, page2);
  };
  const walk = await fetchAllTxs("W", process.env.HELIUS_API_KEY, { stopBeforeSec: 100 });
  assert.equal(walk.txs.length, 3);
  assert.equal(walk.reachedCutoff, true);
  assert.deepEqual(calls, [["primary-key", null], ["primary-key", "s2"], ["backup-key", "s2"]]);
});

test("fetchAllTxs with a foreign key (not in the ring) uses it verbatim and never rotates", async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(keyOf(url)); return res(200, "[]"); };
  await fetchAllTxs("W", "someone-elses-key");
  assert.deepEqual(calls, ["someone-elses-key"]);
});

test("fetchBalance: RPC getBalance follows the ring", async () => {
  markHeliusKeyLimited("primary-key");
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(keyOf(url)); return res(200, '{"result":{"value":1500000000}}'); };
  assert.equal(await fetchBalance("W"), 1.5);
  assert.deepEqual(calls, ["backup-key"]);
});
