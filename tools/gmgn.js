import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Trending token rank (screening source) ──────────────
// GET /v1/market/rank — GMGN's Solana trending list (docs: github.com/GMGNAI/gmgn-skills).
// Returns lightweight token descriptors ({ mint, rank, ... }) or [] on missing
// key / error so screening degrades to Meteora-only discovery.
const TRENDING_INTERVALS = new Set(["1m", "5m", "1h", "6h", "24h"]);

// Cache + inflight dedup (same pattern as getMyPositions in dlmm.js). The
// opportunity poller reuses the getTopCandidates pipeline every ~45s, so an
// uncached fetch here would burn ~1900 GMGN requests/day for data that only
// meaningfully changes on the trendingInterval window. Errors are cached too
// (empty list) so a failing endpoint isn't hammered on every poll.
let _trendingCache = { at: 0, limit: 0, tokens: [] };
let _trendingInflight = null;

export async function getGmgnTrendingTokens({ limit = 10 } = {}) {
  if (!hasGmgnApiKey()) return [];
  const ttlMs = Math.max(0, Number(config.gmgn?.trendingCacheTtlSec ?? 300)) * 1000;
  if (ttlMs > 0 && Date.now() - _trendingCache.at < ttlMs && _trendingCache.limit >= limit) {
    return _trendingCache.tokens.slice(0, limit);
  }
  if (_trendingInflight) {
    return _trendingInflight.then((tokens) => tokens.slice(0, limit));
  }
  _trendingInflight = fetchGmgnTrendingTokens(limit)
    .then((tokens) => {
      _trendingCache = { at: Date.now(), limit, tokens };
      return tokens;
    })
    .finally(() => { _trendingInflight = null; });
  return _trendingInflight;
}

async function fetchGmgnTrendingTokens(limit) {
  const configured = String(config.gmgn?.trendingInterval || "1h");
  const interval = TRENDING_INTERVALS.has(configured) ? configured : "1h";
  try {
    const payload = await gmgnFetch("/v1/market/rank", {
      params: {
        chain: "sol",
        interval,
        limit: Math.min(100, Math.max(1, Math.round(Number(limit) || 10))),
        order_by: config.gmgn?.trendingOrderBy || "swaps",
        direction: "desc",
        filter: ["renounced", "frozen"],
      },
    });
    // Response is double-wrapped like /v1/token/info: { code, data: { code, data: { rank: [...] } } }
    const inner = payload?.data?.data ?? payload?.data ?? {};
    const items = Array.isArray(inner) ? inner : Array.isArray(inner?.rank) ? inner.rank : [];
    const tokens = items
      .map((item, index) => ({
        mint: item?.address || item?.token_address || item?.mint || null,
        symbol: item?.symbol || null,
        rank: num(item?.rank) ?? index + 1,
        smart_degen_count: num(item?.smart_degen_count),
        hot_level: num(item?.hot_level),
        launchpad: item?.launchpad_platform || null,
      }))
      .filter((token) => token.mint);
    if (items.length > 0 && tokens.length === 0) {
      log("gmgn", `trending rank returned ${items.length} item(s) but no parsable mint — response shape may have changed`);
    }
    return tokens;
  } catch (error) {
    log("gmgn", `trending rank fetch failed: ${error.message}`);
    return [];
  }
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}
