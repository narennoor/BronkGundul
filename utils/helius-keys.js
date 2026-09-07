// utils/helius-keys.js — Helius API-key ring with automatic fallback.
//
// Helius quota is ACCOUNT-level, so rotating to a second key on the same
// account does nothing (24–25 Aug 2026: `429 max usage reached` froze both
// agents for 7.5 h — 3,178 failed close attempts). A backup key on a SEPARATE
// account does help, and that is what this module manages:
//
//   HELIUS_API_KEY          primary (as before)
//   HELIUS_API_KEY_BACKUP   one backup (the common case)
//   HELIUS_API_KEYS         optional comma list — appended after the two above
//
// Every Helius HTTP call in the repo goes through `heliusFetch()` (Wallet API,
// enhanced-tx walk) or the `rpcFetch` handed to web3.js `Connection` (RPC).
// On a 429 (or a body that says the quota is gone) the failing key is marked
// limited for `HELIUS_KEY_COOLDOWN_MIN` minutes (default 30), the request is
// retried at once with the next healthy key, and later calls keep using that
// key until the cooldown on the primary expires — then the primary is probed
// again so a recovered daily quota is picked up without a restart.
//
// Three deliberate limits:
//   • Only 429 / quota bodies rotate. 401/403 is a misconfigured key and must
//     stay loud, not be papered over by the backup.
//   • Rotation never sleeps. The existing per-caller backoff (fetchTxPage,
//     web3.js retry-on-429) still applies once every key is limited.
//   • The websocket endpoint of a `Connection` is fixed at construction, so
//     `getConnection()` callers rebuild their Connection when
//     `rpcConnectionKey()` changes — see tools/dlmm.js / tools/wallet.js.

import { log } from "../logger.js";

const DEFAULT_COOLDOWN_MIN = 30;
const QUOTA_BODY_RE = /max usage|usage (limit|reached)|credits? (exhausted|limit)|rate ?limit|too many requests/i;

/** Marked-limited-until timestamps, keyed by api key. Module-global on purpose. */
const _limitedUntil = new Map();
/** The key the ring currently prefers (null = recompute from env). */
let _preferred = null;

function cooldownMs() {
  const n = Number(process.env.HELIUS_KEY_COOLDOWN_MIN);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_MIN) * 60_000;
}

function mask(key) {
  const s = String(key || "");
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Primary key = HELIUS_API_KEY, else the api-key baked into RPC_URL. */
function primaryFromEnv() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  try {
    return new URL(process.env.RPC_URL || "").searchParams.get("api-key") || null;
  } catch {
    return null;
  }
}

/** Ordered, de-duplicated key ring: [primary, backup, ...extra]. */
export function heliusKeyRing() {
  const raw = [
    primaryFromEnv(),
    process.env.HELIUS_API_KEY_BACKUP,
    process.env.HELIUS_BACKUP_API_KEY,
    ...String(process.env.HELIUS_API_KEYS || "").split(","),
  ];
  const out = [];
  for (const k of raw) {
    const key = String(k || "").trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export function isKeyLimited(key, now = Date.now()) {
  const until = _limitedUntil.get(key);
  if (!until) return false;
  if (until <= now) {
    _limitedUntil.delete(key);
    return false;
  }
  return true;
}

/**
 * The key to use right now: the first non-limited key in ring order. When
 * every key is limited, the one whose cooldown expires soonest — the caller's
 * own backoff then handles the wait. Returns null when no key is configured.
 */
export function activeHeliusKey(now = Date.now()) {
  const ring = heliusKeyRing();
  if (!ring.length) return null;
  const healthy = ring.find((k) => !isKeyLimited(k, now));
  const next = healthy ?? ring.reduce((a, b) => (_limitedUntil.get(a) <= _limitedUntil.get(b) ? a : b));
  if (next !== _preferred) {
    if (_preferred !== null) {
      const idx = ring.indexOf(next);
      log("helius_warn", `Helius key aktif → #${idx} ${mask(next)}${healthy ? "" : " (semua key kena limit)"}`);
    }
    _preferred = next;
  }
  return next;
}

/** True when the ring holds a key other than `key` that is not limited. */
export function hasFallbackFor(key, now = Date.now()) {
  return heliusKeyRing().some((k) => k !== key && !isKeyLimited(k, now));
}

/**
 * Mark `key` limited for the cooldown (or the server's Retry-After when it is
 * longer). Returns the next key to try, or null when there is no healthy one.
 */
export function markHeliusKeyLimited(key, { retryAfterSec = null, reason = "" } = {}, now = Date.now()) {
  if (!key) return null;
  const ms = Math.max(cooldownMs(), Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0);
  _limitedUntil.set(key, now + ms);
  const ring = heliusKeyRing();
  const next = ring.find((k) => k !== key && !isKeyLimited(k, now)) || null;
  log(
    "helius_warn",
    `Helius key #${ring.indexOf(key)} ${mask(key)} kena limit${reason ? ` (${reason})` : ""}; ` +
      `cooldown ${Math.round(ms / 60_000)}m` + (next ? ` → fallback ke #${ring.indexOf(next)} ${mask(next)}` : " — tidak ada key cadangan sehat"),
  );
  return next;
}

/** Test hook — forget every limit mark. */
export function resetHeliusKeyState() {
  _limitedUntil.clear();
  _preferred = null;
}

/**
 * Decide whether a response means "this key's quota is gone". 429 always
 * counts; other non-ok statuses only when the body says so (Helius has
 * returned quota errors under more than one status over time).
 */
export async function isQuotaResponse(res) {
  if (!res) return false;
  if (res.status === 429) return true;
  if (res.ok || res.status === 401) return false;
  try {
    const text = await res.clone().text();
    return QUOTA_BODY_RE.test(text.slice(0, 500));
  } catch {
    return false;
  }
}

function retryAfterOf(res) {
  const n = Number(res?.headers?.get?.("retry-after"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Swap the `api-key` query param (or append it) on a Helius URL. */
export function withApiKey(url, key) {
  const u = new URL(String(url));
  u.searchParams.set("api-key", key);
  return u.toString();
}

/** RPC URL for `key`: RPC_URL_BACKUP when the backup is active and set, else RPC_URL re-keyed. */
export function rpcUrlForKey(key) {
  const base = process.env.RPC_URL;
  if (!base) return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
  if (!key) return base;
  const ring = heliusKeyRing();
  if (ring[0] === key) return base;
  if (process.env.RPC_URL_BACKUP && ring[1] === key) return process.env.RPC_URL_BACKUP;
  try {
    const u = new URL(base);
    if (!u.searchParams.has("api-key")) return base; // not a keyed Helius URL — nothing to rotate
    return withApiKey(base, key);
  } catch {
    return base;
  }
}

/** The RPC URL to use right now. */
export function activeRpcUrl() {
  return rpcUrlForKey(activeHeliusKey());
}

/**
 * Identity of the RPC endpoint the active key maps to. `getConnection()`
 * callers compare this to the value they built their Connection with and
 * rebuild on change, so the websocket follows the fallback too.
 */
export function rpcConnectionKey() {
  return activeRpcUrl() || "";
}

/**
 * fetch() against a Helius HTTP API. `makeUrl(key)` builds the request for a
 * given key; on a quota response the key is marked limited and the request is
 * retried once per remaining healthy key. The final response is returned
 * as-is (never thrown) so callers keep their own status handling.
 */
export async function heliusFetch(makeUrl, init = undefined, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const tried = new Set();
  let key = activeHeliusKey();
  if (!key) throw new Error("HELIUS_API_KEY not set");
  let res;
  for (;;) {
    tried.add(key);
    res = await doFetch(makeUrl(key), init);
    if (!(await isQuotaResponse(res))) return res;
    const next = markHeliusKeyLimited(key, { retryAfterSec: retryAfterOf(res), reason: `HTTP ${res.status}` });
    if (!next || tried.has(next)) return res;
    key = next;
  }
}

/**
 * A drop-in `fetch` for web3.js `Connection({ fetch })`: same contract as
 * heliusFetch but the URL comes from the Connection, so the key is swapped in
 * place. Non-Helius URLs pass straight through.
 */
export async function rpcFetch(input, init) {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  let u;
  try { u = new URL(url); } catch { return globalThis.fetch(input, init); }
  if (!u.searchParams.has("api-key") || heliusKeyRing().length < 2) return globalThis.fetch(input, init);
  return heliusFetch((key) => rpcUrlForKey(key), init);
}

/** Options bag for `new Connection(url, …)` that routes through the ring. */
export function rpcConnectionConfig(commitment = "confirmed") {
  return { commitment, fetch: rpcFetch };
}

export const _internal = { mask, QUOTA_BODY_RE };
