import { config } from "../config.js";
import { log } from "../logger.js";

// ─── DexScreener boosted tokens (screening source) ──────────────
// GET https://api.dexscreener.com/token-boosts/{top,latest}/v1 — public, no
// API key. DexScreener has no public "trending" endpoint; active boosts are
// the closest attention signal it exposes (top = largest active boosts,
// latest = most recent). Boosts are paid promotion, so every candidate still
// runs the full hard-filter pipeline downstream. Returns lightweight token
// descriptors ({ mint, rank, ... }) or [] on error so screening degrades to
// Meteora-only discovery. Same token-first contract as getJupTrendingTokens.
const DEXSCREENER_API = "https://api.dexscreener.com";
const BOOST_CATEGORIES = new Set(["top", "latest"]);
const DEFAULT_CATEGORIES = ["top", "latest"];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Cache + inflight dedup (same pattern as getJupTrendingTokens). The
// opportunity poller reuses the getTopCandidates pipeline every ~45s and the
// boosts endpoints are rate-limited at 60 req/min, so uncached fetches would
// burn the quota on lists that barely change. Errors are cached too (empty
// list) so a failing endpoint isn't hammered on every poll.
let _boostCache = { at: 0, limit: 0, tokens: [] };
let _boostInflight = null;

export async function getDexScreenerTokens({ limit = 10 } = {}) {
  const ttlMs = Math.max(0, Number(config.screening?.dexScreenerCacheTtlSec ?? 300)) * 1000;
  if (ttlMs > 0 && Date.now() - _boostCache.at < ttlMs && _boostCache.limit >= limit) {
    return sliceMerged(_boostCache.tokens, limit);
  }
  if (_boostInflight) {
    return _boostInflight.then((tokens) => sliceMerged(tokens, limit));
  }
  _boostInflight = fetchDexScreenerTokens(limit)
    .then((tokens) => {
      _boostCache = { at: Date.now(), limit, tokens };
      return tokens;
    })
    .finally(() => { _boostInflight = null; });
  return _boostInflight;
}

// `limit` is per category; the merged list can hold up to limit × categories
// distinct mints (a mint on both lists is deduped, keeping its best rank).
function sliceMerged(tokens, limit) {
  return tokens.slice(0, limit * getConfiguredCategories().length);
}

function getConfiguredCategories() {
  const configured = Array.isArray(config.screening?.dexScreenerCategories)
    ? config.screening.dexScreenerCategories.filter((c) => BOOST_CATEGORIES.has(String(c)))
    : [];
  return configured.length > 0 ? configured : DEFAULT_CATEGORIES;
}

async function fetchDexScreenerTokens(limit) {
  const categories = getConfiguredCategories();
  const cappedLimit = Math.min(100, Math.max(1, Math.round(Number(limit) || 10)));

  const results = await Promise.allSettled(
    categories.map((category) => fetchBoostCategory(category, cappedLimit))
  );

  // Merge across categories, dedup by mint keeping the best (lowest) rank;
  // a mint on both lists gets its categories joined ("top+latest").
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
        if ((token.boost_total ?? 0) > (existing.boost_total ?? 0)) existing.boost_total = token.boost_total;
      }
    }
  }
  return Array.from(byMint.values()).sort((a, b) => a.rank - b.rank);
}

async function fetchBoostCategory(category, limit) {
  try {
    const res = await fetch(`${DEXSCREENER_API}/token-boosts/${category}/v1`);
    if (!res.ok) throw new Error(`token-boosts/${category} ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data) ? data : [];
    const tokens = items
      .filter((item) => item?.chainId === "solana" && item?.tokenAddress)
      .map((item, index) => ({
        mint: item.tokenAddress,
        symbol: null, // boosts endpoints carry no symbol; pool resolution supplies it
        rank: index + 1,
        category,
        boost_total: num(item.totalAmount ?? item.amount),
        launchpad: null,
      }))
      .slice(0, limit);
    if (items.length > 0 && tokens.length === 0) {
      log("dexscreener", `token-boosts/${category} returned ${items.length} item(s) but no solana mint — response shape may have changed`);
    }
    return tokens;
  } catch (error) {
    log("dexscreener", `token-boosts/${category} fetch failed: ${error.message}`);
    return [];
  }
}
