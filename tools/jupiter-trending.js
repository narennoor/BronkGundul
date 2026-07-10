import { config } from "../config.js";
import { log } from "../logger.js";

// ─── Jupiter datapi trending/toptraded rank (screening source) ──────────────
// GET https://datapi.jup.ag/v1/pools/{category}/{interval} — the list backing
// jup.ag's Trending / Top Traded tabs. Public, no API key. Returns lightweight
// token descriptors ({ mint, rank, ... }) or [] on error so screening degrades
// to Meteora-only discovery. Same token-first contract as getGmgnTrendingTokens.
const DATAPI_JUP = "https://datapi.jup.ag/v1";
const TRENDING_INTERVALS = new Set(["5m", "1h", "6h", "24h"]);
const TRENDING_CATEGORIES = new Set(["toptrending", "toptraded"]);
const DEFAULT_CATEGORIES = ["toptrending", "toptraded"];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Cache + inflight dedup (same pattern as getGmgnTrendingTokens in gmgn.js).
// The opportunity poller reuses the getTopCandidates pipeline every ~45s, so an
// uncached fetch here would hit datapi.jup.ag ~1900×/day for lists that only
// meaningfully change on the trending window. Errors are cached too (empty
// list) so a failing endpoint isn't hammered on every poll.
let _trendingCache = { at: 0, limit: 0, tokens: [] };
let _trendingInflight = null;

export async function getJupTrendingTokens({ limit = 10 } = {}) {
  const ttlMs = Math.max(0, Number(config.screening?.jupTrendingCacheTtlSec ?? 300)) * 1000;
  if (ttlMs > 0 && Date.now() - _trendingCache.at < ttlMs && _trendingCache.limit >= limit) {
    return sliceMerged(_trendingCache.tokens, limit);
  }
  if (_trendingInflight) {
    return _trendingInflight.then((tokens) => sliceMerged(tokens, limit));
  }
  _trendingInflight = fetchJupTrendingTokens(limit)
    .then((tokens) => {
      _trendingCache = { at: Date.now(), limit, tokens };
      return tokens;
    })
    .finally(() => { _trendingInflight = null; });
  return _trendingInflight;
}

// `limit` is per category; the merged list can hold up to limit × categories
// distinct mints (a mint on both lists is deduped, keeping its best rank).
function sliceMerged(tokens, limit) {
  const categories = getConfiguredCategories();
  return tokens.slice(0, limit * categories.length);
}

function getConfiguredCategories() {
  const configured = Array.isArray(config.screening?.jupTrendingCategories)
    ? config.screening.jupTrendingCategories.filter((c) => TRENDING_CATEGORIES.has(String(c)))
    : [];
  return configured.length > 0 ? configured : DEFAULT_CATEGORIES;
}

async function fetchJupTrendingTokens(limit) {
  const configured = String(config.screening?.jupTrendingInterval || "1h");
  const interval = TRENDING_INTERVALS.has(configured) ? configured : "1h";
  const categories = getConfiguredCategories();
  const cappedLimit = Math.min(100, Math.max(1, Math.round(Number(limit) || 10)));

  const results = await Promise.allSettled(
    categories.map((category) => fetchJupTrendingCategory(category, interval, cappedLimit))
  );

  // Merge across categories, dedup by mint keeping the best (lowest) rank;
  // a mint on both lists gets its categories joined ("toptrending+toptraded").
  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const token of result.value) {
      const existing = byMint.get(token.mint);
      if (!existing) {
        byMint.set(token.mint, token);
      } else {
        existing.category = `${existing.category}+${token.category}`;
        if (token.rank < existing.rank) existing.rank = token.rank;
        existing.launchpad ||= token.launchpad;
      }
    }
  }
  return Array.from(byMint.values()).sort((a, b) => a.rank - b.rank);
}

async function fetchJupTrendingCategory(category, interval, limit) {
  try {
    const res = await fetch(`${DATAPI_JUP}/pools/${category}/${interval}`);
    if (!res.ok) throw new Error(`pools/${category}/${interval} ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data?.pools) ? data.pools : [];
    const tokens = items
      .map((item, index) => ({
        mint: item?.baseAsset?.id || null,
        symbol: item?.baseAsset?.symbol || null,
        rank: index + 1,
        category,
        organic_score: num(item?.baseAsset?.organicScore),
        launchpad: item?.baseAsset?.launchpad || null,
      }))
      .filter((token) => token.mint)
      .slice(0, limit);
    if (items.length > 0 && tokens.length === 0) {
      log("jup_trending", `${category}/${interval} returned ${items.length} item(s) but no parsable mint — response shape may have changed`);
    }
    return tokens;
  } catch (error) {
    log("jup_trending", `${category}/${interval} fetch failed: ${error.message}`);
    return [];
  }
}
