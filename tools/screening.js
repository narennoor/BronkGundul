import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { isBotFilterMintOnCooldown } from "../bot-filter.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { getGmgnTrendingTokens, hasGmgnApiKey } from "./gmgn.js";
import { getJupTrendingTokens } from "./jupiter-trending.js";
import { getDexScreenerTokens } from "./dexscreener.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this reference
// window, so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  // fee_tvl multiplier halved 1000→500 (2026-07-07): Darwin decayed
  // fee_tvl_ratio to 0.77 over 7 straight recalcs — entry-time fee/TVL was
  // the least predictive signal, yet it dominated candidate ranking.
  return feeTvl * 500 + organic * 10 + volume / 100 + holders / 100;
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity   → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity        → unique_lps + positions_created
 *   3. Fees paid to LPs          → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity                 → active_tvl (log floor — dust pools can't win on ratios)
 * Efficiency only (no momentum/change_pct), per design. Targets are configurable so the
 * score can be calibrated; each sub-score saturates at its target.
 *
 * The volume/fee/LP inputs are measured over `config.screening.timeframe`, so they are
 * normalized to a fixed 30m reference window before scoring — the targets are expressed
 * in 30m terms and stay valid even if the timeframe changes (5m, 1h, 24h, …). Liquidity
 * is a level, not a rate, so it is not scaled.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,    // (30m) volume/active_tvl that earns a full trading sub-score
    targetLpCount = 40,     // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,  // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (Number(s.minBaseFeePct) > 0) {
    const baseFeePct = numeric(pool?.fee_pct);
    if (baseFeePct == null || baseFeePct < Number(s.minBaseFeePct)) {
      return `base fee ${baseFeePct ?? "unknown"}% below minBaseFeePct ${s.minBaseFeePct}%`;
    }
  }
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (s.maxFeeActiveTvlRatio != null && s.maxFeeActiveTvlRatio > 0 && feeActiveTvlRatio > s.maxFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio} above maxFeeActiveTvlRatio ${s.maxFeeActiveTvlRatio}`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    (pool?.discord_signal || pool?.gmgn_trending || pool?.jup_trending || pool?.dexscreener_boost) &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findTopDlmmPoolByMint(mint, minTvl) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`dlmm pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function findRivalPool(mint) {
  return findTopDlmmPoolByMint(mint, PVP_MIN_ACTIVE_TVL);
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

/**
 * Merge GMGN trending tokens into the discovery pool set (token-first source).
 * Each trending mint is resolved to its highest-TVL DLMM pool, then re-fetched
 * from the pool discovery API so the object shape matches native discovery
 * pools — every downstream filter/enrichment applies unchanged. Mints whose
 * pool is already in the discovery set just get tagged (confirmation signal).
 */
async function mergeGmgnTrendingPools(rawPools, s) {
  const trendingTokens = await getGmgnTrendingTokens({ limit: s.gmgnTrendingLimit });
  if (trendingTokens.length === 0) return rawPools;

  const tagPool = (pool, token) => {
    pool.gmgn_trending = true;
    pool.gmgn_trending_rank = token.rank;
    pool.gmgn_smart_degen_count = token.smart_degen_count;
    pool.gmgn_hot_level = token.hot_level;
    if (token.launchpad && !getPoolLaunchpad(pool)) pool.base_token_launchpad = token.launchpad;
  };

  const byMint = new Map();
  for (const pool of rawPools) {
    const mint = getPoolBaseMint(pool);
    if (mint && !byMint.has(mint)) byMint.set(mint, pool);
  }

  const unresolved = [];
  let tagged = 0;
  for (const token of trendingTokens) {
    const existing = byMint.get(token.mint);
    if (existing) {
      tagPool(existing, token);
      tagged++;
    } else if (!isBlacklisted(token.mint)) {
      unresolved.push(token);
    }
  }

  const minTvl = Math.max(1, Number(s.minTvl) || 1);
  const resolved = await Promise.allSettled(
    unresolved.map(async (token) => {
      const match = await findTopDlmmPoolByMint(token.mint, minTvl);
      const poolAddress = match?.address || match?.pool_address;
      if (!poolAddress) return null;
      const pool = await fetchPoolDiscoveryDetail({ poolAddress, timeframe: s.timeframe });
      if (!pool) return null;
      tagPool(pool, token);
      return pool;
    })
  );

  const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
  let added = 0;
  for (const result of resolved) {
    const pool = result.status === "fulfilled" ? result.value : null;
    if (!pool?.pool_address || byPool.has(pool.pool_address)) continue;
    byPool.set(pool.pool_address, pool);
    added++;
  }
  log("screening", `GMGN trending: ${trendingTokens.length} token(s) → ${added} new pool(s) merged, ${tagged} existing tagged`);
  return Array.from(byPool.values());
}

/**
 * Merge Jupiter datapi trending/toptraded tokens into the discovery pool set
 * (token-first source, same contract as mergeGmgnTrendingPools). Each trending
 * mint is resolved to its highest-TVL DLMM pool, then re-fetched from the pool
 * discovery API so the object shape matches native discovery pools — every
 * downstream filter/enrichment applies unchanged. Mints whose pool is already
 * in the discovery set just get tagged (confirmation signal).
 */
async function mergeJupTrendingPools(rawPools, s) {
  const trendingTokens = await getJupTrendingTokens({ limit: s.jupTrendingLimit });
  if (trendingTokens.length === 0) return rawPools;

  const tagPool = (pool, token) => {
    pool.jup_trending = true;
    pool.jup_trending_rank = token.rank;
    pool.jup_trending_category = token.category;
    if (token.launchpad && !getPoolLaunchpad(pool)) pool.base_token_launchpad = token.launchpad;
  };

  const byMint = new Map();
  for (const pool of rawPools) {
    const mint = getPoolBaseMint(pool);
    if (mint && !byMint.has(mint)) byMint.set(mint, pool);
  }

  const unresolved = [];
  let tagged = 0;
  for (const token of trendingTokens) {
    const existing = byMint.get(token.mint);
    if (existing) {
      tagPool(existing, token);
      tagged++;
    } else if (!isBlacklisted(token.mint)) {
      unresolved.push(token);
    }
  }

  const minTvl = Math.max(1, Number(s.minTvl) || 1);
  const resolved = await Promise.allSettled(
    unresolved.map(async (token) => {
      const match = await findTopDlmmPoolByMint(token.mint, minTvl);
      const poolAddress = match?.address || match?.pool_address;
      if (!poolAddress) return null;
      const pool = await fetchPoolDiscoveryDetail({ poolAddress, timeframe: s.timeframe });
      if (!pool) return null;
      tagPool(pool, token);
      return pool;
    })
  );

  const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
  let added = 0;
  for (const result of resolved) {
    const pool = result.status === "fulfilled" ? result.value : null;
    if (!pool?.pool_address || byPool.has(pool.pool_address)) continue;
    byPool.set(pool.pool_address, pool);
    added++;
  }
  log("screening", `Jup trending: ${trendingTokens.length} token(s) → ${added} new pool(s) merged, ${tagged} existing tagged`);
  return Array.from(byPool.values());
}

/**
 * Merge DexScreener boosted tokens into the discovery pool set (token-first
 * source, same contract as mergeJupTrendingPools). Each boosted mint is
 * resolved to its highest-TVL DLMM pool, then re-fetched from the pool
 * discovery API so the object shape matches native discovery pools — every
 * downstream filter/enrichment applies unchanged. Mints whose pool is already
 * in the discovery set just get tagged (confirmation signal).
 */
async function mergeDexScreenerPools(rawPools, s) {
  const boostedTokens = await getDexScreenerTokens({ limit: s.dexScreenerLimit });
  if (boostedTokens.length === 0) return rawPools;

  const tagPool = (pool, token) => {
    pool.dexscreener_boost = true;
    pool.dexscreener_rank = token.rank;
    pool.dexscreener_category = token.category;
    pool.dexscreener_boost_total = token.boost_total;
  };

  const byMint = new Map();
  for (const pool of rawPools) {
    const mint = getPoolBaseMint(pool);
    if (mint && !byMint.has(mint)) byMint.set(mint, pool);
  }

  const unresolved = [];
  let tagged = 0;
  for (const token of boostedTokens) {
    const existing = byMint.get(token.mint);
    if (existing) {
      tagPool(existing, token);
      tagged++;
    } else if (!isBlacklisted(token.mint)) {
      unresolved.push(token);
    }
  }

  const minTvl = Math.max(1, Number(s.minTvl) || 1);
  const resolved = await Promise.allSettled(
    unresolved.map(async (token) => {
      const match = await findTopDlmmPoolByMint(token.mint, minTvl);
      const poolAddress = match?.address || match?.pool_address;
      if (!poolAddress) return null;
      const pool = await fetchPoolDiscoveryDetail({ poolAddress, timeframe: s.timeframe });
      if (!pool) return null;
      tagPool(pool, token);
      return pool;
    })
  );

  const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
  let added = 0;
  for (const result of resolved) {
    const pool = result.status === "fulfilled" ? result.value : null;
    if (!pool?.pool_address || byPool.has(pool.pool_address)) continue;
    byPool.set(pool.pool_address, pool);
    added++;
  }
  log("screening", `DexScreener boosts: ${boostedTokens.length} token(s) → ${added} new pool(s) merged, ${tagged} existing tagged`);
  return Array.from(byPool.values());
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    s.maxFeeActiveTvlRatio != null ? `fee_active_tvl_ratio<=${s.maxFeeActiveTvlRatio}` : null,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = Array.isArray(data.data) ? data.data : [];

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot
      await refreshDiscordOnlyPools(rawPools, s.timeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, s.timeframe);
      }
    }
  }

  if (s.useGmgnTrending && hasGmgnApiKey()) {
    rawPools = await mergeGmgnTrendingPools(rawPools, s).catch((error) => {
      log("screening", `GMGN trending merge failed: ${error.message}`);
      return rawPools;
    });
  }

  if (s.useJupTrending) {
    rawPools = await mergeJupTrendingPools(rawPools, s).catch((error) => {
      log("screening", `Jup trending merge failed: ${error.message}`);
      return rawPools;
    });
  }

  if (s.useDexScreener) {
    rawPools = await mergeDexScreenerPools(rawPools, s).catch((error) => {
      log("screening", `DexScreener boosts merge failed: ${error.message}`);
      return rawPools;
    });
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const discovery = await discoverPools({ page_size: 50 });
  const { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);
  const maxFeeActiveTvlRatio = config.screening.maxFeeActiveTvlRatio == null ? null : Number(config.screening.maxFeeActiveTvlRatio);

  // Funnel instrumentation (observe-all): every check below records its failure
  // instead of short-circuiting, so funnel-stats.json can attribute kills and
  // unique-kills per filter. Filtering OUTCOME is unchanged — a pool is eligible
  // iff failures is empty, same as the old first-failure-wins chain.
  const funnelEnabled = config.screening.funnelStatsEnabled !== false;
  const killedFailures = []; // string[][] — all failed filter names per killed pool

  const eligible = pools
    .filter((p) => {
      const failures = [];
      const reasons = [];
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        failures.push("minTvl");
        reasons.push(`TVL $${tvl} below minTvl $${minTvl}`);
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        failures.push("maxTvl");
        reasons.push(`TVL $${tvl} above maxTvl $${maxTvl}`);
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        failures.push("minFeeActiveTvlRatio");
        reasons.push(`fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
      }
      if (maxFeeActiveTvlRatio != null && maxFeeActiveTvlRatio > 0 && Number.isFinite(feeActiveTvlRatio) && feeActiveTvlRatio > maxFeeActiveTvlRatio) {
        failures.push("maxFeeActiveTvlRatio");
        reasons.push(`fee/active-TVL ${feeActiveTvlRatio} above maxFeeActiveTvlRatio ${maxFeeActiveTvlRatio}`);
      }
      if (!isUsableVolatility(p.volatility)) {
        failures.push("volatilityUnusable");
        reasons.push(`volatility ${p.volatility ?? "unknown"} is unusable`);
      }
      if (occupiedPools.has(p.pool)) {
        failures.push("occupiedPool");
        reasons.push("already have an open position in this pool");
      }
      if (occupiedMints.has(p.base?.mint)) {
        failures.push("occupiedMint");
        reasons.push("already holding this base token in another pool");
      }
      // Cooldown checks cost a pool-memory.json read each — only evaluate them
      // for pools that passed everything else. Their kills are therefore always
      // unique kills (the pool would have passed but for the cooldown).
      if (failures.length === 0) {
        if (isPoolOnCooldown(p.pool)) {
          log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
          failures.push("poolCooldown");
          reasons.push("pool cooldown active");
        } else if (isBaseMintOnCooldown(p.base?.mint)) {
          log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
          failures.push("tokenCooldown");
          reasons.push("token cooldown active");
        } else if (isBotFilterMintOnCooldown(p.base?.mint)) {
          log("screening", `Filtered bot-filter cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
          failures.push("botFilterCooldown");
          reasons.push("bot-filter strike cooldown active");
        }
      }
      if (failures.length === 0) return true;
      pushFilteredReason(filteredOut, p, reasons[0]);
      if (funnelEnabled) killedFailures.push(failures);
      return false;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => {
        pushFilteredReason(filteredOut, p, "PVP hard filter");
        if (funnelEnabled) killedFailures.push(["pvpHardFilter"]);
      });
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Dev blocklist check — filter pools whose creator is on the blocklist
  if (eligible.length > 0) {
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        if (funnelEnabled) killedFailures.push(["blockedDeployer"]);
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via dev blocklist`);
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      if (funnelEnabled) killedFailures.push(["indicatorReject"]);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  // Funnel stats write + periodic shadow run. Observability only — never throws
  // into the screening path, never changes candidates.
  if (funnelEnabled) {
    try {
      const { recordFunnelCycle, getFunnelStats, summarizeFunnel } = await import("../funnel-stats.js");
      const stats = recordFunnelCycle("client", {
        poolsSeen: pools.length,
        passed: eligible.length,
        failuresByPool: killedFailures,
      });
      log("funnel", summarizeFunnel("client"));
      const everyN = Number(config.screening.funnelShadowEveryNCycles ?? 12);
      if (everyN > 0 && (stats.client.cycles % everyN === 1 || everyN === 1)) {
        runShadowFunnel().catch((error) => log("funnel", `Shadow funnel failed: ${error.message}`));
      }
    } catch (error) {
      log("funnel", `Funnel stats failed: ${error.message}`);
    }
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Shadow funnel (Tier 2) — fetch discovery with a minimal query (pool_type +
 * volume baseline only) and apply ALL configured screening thresholds
 * client-side, counting which filter kills what. This attributes kills for
 * filters normally enforced server-side inside the discovery query (mcap,
 * holders, bin step, fee band, organic, age), which the client otherwise
 * never sees. Launchpad allow/block lists and critical-warning flags are not
 * simulated (fields not reliably present on the raw objects).
 */
export async function runShadowFunnel() {
  const s = config.screening;
  const baselineVolume = Math.min(500, Number(s.minVolume) || 500);
  const filters = ["pool_type=dlmm", `volume>=${baselineVolume}`].join("&&");
  const data = await fetchPoolDiscoveryPage({
    page_size: 100,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });
  const rawPools = Array.isArray(data.data) ? data.data : [];
  const failuresByPool = [];
  let passed = 0;
  for (const p of rawPools) {
    const failures = shadowThresholdFailures(p, s);
    if (failures.length === 0) passed += 1;
    else failuresByPool.push(failures);
  }
  const { recordFunnelCycle, summarizeFunnel } = await import("../funnel-stats.js");
  recordFunnelCycle("shadow", { poolsSeen: rawPools.length, passed, failuresByPool });
  log("funnel", `Shadow run: ${rawPools.length} pools @ volume>=${baselineVolume}, ${passed} pass all thresholds | ${summarizeFunnel("shadow")}`);
}

/** All configured threshold failures for one RAW discovery pool object. */
function shadowThresholdFailures(p, s) {
  const failures = [];
  const mcap = Number(p.token_x?.market_cap ?? NaN);
  if (Number(s.minMcap) > 0 && !(mcap >= Number(s.minMcap))) failures.push("minMcap");
  if (s.maxMcap != null && !(mcap <= Number(s.maxMcap))) failures.push("maxMcap");
  const holders = Number(p.base_token_holders ?? NaN);
  if (Number(s.minHolders) > 0 && !(holders >= Number(s.minHolders))) failures.push("minHolders");
  const volume = Number(p.volume ?? NaN);
  if (Number(s.minVolume) > 0 && !(volume >= Number(s.minVolume))) failures.push("minVolume");
  const tvl = Number(p.tvl ?? NaN);
  if (Number(s.minTvl) > 0 && !(tvl >= Number(s.minTvl))) failures.push("minTvl");
  if (s.maxTvl != null && !(tvl <= Number(s.maxTvl))) failures.push("maxTvl");
  const binStep = Number(p.dlmm_params?.bin_step ?? NaN);
  if (Number(s.minBinStep) > 0 && !(binStep >= Number(s.minBinStep))) failures.push("minBinStep");
  if (Number(s.maxBinStep) > 0 && !(binStep <= Number(s.maxBinStep))) failures.push("maxBinStep");
  const baseFeePct = Number(p.fee_pct ?? NaN);
  if (Number(s.minBaseFeePct) > 0 && !(baseFeePct >= Number(s.minBaseFeePct))) failures.push("minBaseFeePct");
  const ratio = Number(p.fee_active_tvl_ratio ?? NaN);
  if (Number(s.minFeeActiveTvlRatio) > 0 && !(ratio >= Number(s.minFeeActiveTvlRatio))) failures.push("minFeeActiveTvlRatio");
  if (s.maxFeeActiveTvlRatio != null && Number(s.maxFeeActiveTvlRatio) > 0 && Number.isFinite(ratio) && ratio > Number(s.maxFeeActiveTvlRatio)) failures.push("maxFeeActiveTvlRatio");
  const organic = Number(p.token_x?.organic_score ?? NaN);
  if (Number(s.minOrganic) > 0 && !(organic >= Number(s.minOrganic))) failures.push("minOrganic");
  const quoteOrganic = Number(p.token_y?.organic_score ?? NaN);
  if (Number(s.minQuoteOrganic) > 0 && !(quoteOrganic >= Number(s.minQuoteOrganic))) failures.push("minQuoteOrganic");
  const createdAt = Number(p.token_x?.created_at ?? NaN);
  if (s.minTokenAgeHours != null && Number.isFinite(createdAt) && Date.now() - createdAt < Number(s.minTokenAgeHours) * 3_600_000) failures.push("minTokenAgeHours");
  if (s.maxTokenAgeHours != null && Number.isFinite(createdAt) && Date.now() - createdAt > Number(s.maxTokenAgeHours) * 3_600_000) failures.push("maxTokenAgeHours");
  return failures;
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,
    gmgn_trending: Boolean(p.gmgn_trending),
    gmgn_trending_rank: p.gmgn_trending_rank ?? null,
    gmgn_smart_degen_count: p.gmgn_smart_degen_count ?? null,
    jup_trending: Boolean(p.jup_trending),
    jup_trending_rank: p.jup_trending_rank ?? null,
    jup_trending_category: p.jup_trending_category ?? null,
    dexscreener_boost: Boolean(p.dexscreener_boost),
    dexscreener_rank: p.dexscreener_rank ?? null,
    dexscreener_category: p.dexscreener_category ?? null,
    dexscreener_boost_total: p.dexscreener_boost_total ?? null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    unique_lps_change_pct: fix(p.unique_lps_change_pct, 1),
    positions_created: p.positions_created,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
