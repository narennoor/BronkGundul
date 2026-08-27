import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  countablePositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
  waitForCloseBookkeeping,
} from "./dlmm.js";
import { getWalletBalances, getSolBalance, swapToken, normalizeMint, reconcileCycleCash } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, attachExitExecution, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceEntry, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import { resolveReportCutoff } from "../pnl-report.js";
import fs from "fs";
import { execSync } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
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
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, sendMessage } from "../telegram.js";
import { writeJsonAtomic } from "../utils/json-store.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  // The fee/TVL gate reads the slow (>=30m) window, same as volatility: a 5m
  // point-sample flaps between 0 and extreme spikes minutes apart, so candidates
  // that passed screening on a hot window get blocked on an empty one. Both
  // readings are logged + persisted for era attribution.
  const slowTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let slowDetail = detail;
  if ((config.screening.timeframe || "5m") !== slowTimeframe) {
    try {
      slowDetail = await fetchFreshPoolDetail(args.pool_address, slowTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${slowTimeframe} fee/volatility before deploy: ${error.message}`,
      };
    }
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(slowDetail);
  const feeActiveTvlRatioFast = poolDetailFeeActiveTvlRatio(detail);
  log(
    "safety",
    `Deploy fee/TVL gate ${args.pool_address}: ${slowTimeframe}=${feeActiveTvlRatio ?? "unknown"} ${config.screening.timeframe || "5m"}=${feeActiveTvlRatioFast ?? "unknown"}`
  );
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool ${slowTimeframe} fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }
  const maxFeeActiveTvlRatio = numberOrNull(config.screening.maxFeeActiveTvlRatio);
  if (
    maxFeeActiveTvlRatio != null &&
    maxFeeActiveTvlRatio > 0 &&
    feeActiveTvlRatio != null &&
    feeActiveTvlRatio > maxFeeActiveTvlRatio
  ) {
    return {
      pass: false,
      reason: `Pool ${slowTimeframe} fee/active-TVL ${feeActiveTvlRatio}% is above configured maxFeeActiveTvlRatio ${maxFeeActiveTvlRatio}% (peak-degen pool, mean-reversion risk).`,
    };
  }

  const volatility = poolDetailVolatility(slowDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${slowTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
    entry_fee_tvl_fast: feeActiveTvlRatioFast,
    entry_fee_tvl_slow: feeActiveTvlRatio,
    fee_gate_timeframe: slowTimeframe,
  };

  return { pass: true, entryMarketData };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "useGmgnTrending",
    "useJupTrending",
    "useDexScreener",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "sweepEnabled",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
    "reportSnapshotEnabled",
    "reportWeeklyEnabled",
    "reportMonthlyEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads", "jupTrendingCategories", "dexScreenerCategories", "sweepExcludeMints"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "strategyMode",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "pnlReportSinceIso",
    "gmgnFeeSource",
    "gmgnApiKey",
    "gmgnTrendingInterval",
    "gmgnTrendingOrderBy",
    "jupTrendingInterval",
    "reportSnapshotCronUtc",
    "reportLedgerRole",
    "reportLedgerDir",
    "reportRegistryPath",
    "reportPositionValuation",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) {
    const str = coerceString(value, key);
    // Reject a bad cutoff HERE rather than at /pnl time — V8 happily reads
    // "21 juli" as 2001-07-21, so a typo would silently cut off nothing and
    // the report would look plausible.
    if (key === "pnlReportSinceIso" && str) resolveReportCutoff(str);
    return str;
  }
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    // operator policy (2026-07-06): CHECK-ONLY. Fetches the remote and reports
    // pending upstream commits, never pulls or restarts — an unattended
    // `git pull` is an RCE path (compromised upstream runs arbitrary code on
    // the wallet machine) and would also overwrite the local security patches.
    // The operator reviews the diff and updates manually.
    try {
      execSync("git fetch --quiet", { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });
      let range = "HEAD..@{upstream}";
      try {
        execSync("git rev-parse --abbrev-ref --symbolic-full-name @{upstream}", { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
      } catch {
        range = "HEAD..origin/main";
      }
      const behind = Number(execSync(`git rev-list --count ${range}`, { cwd: REPO_ROOT, encoding: "utf8" }).trim());
      if (!behind) {
        return { success: true, updated: false, check_only: true, behind: 0, message: "Already up to date with upstream." };
      }
      const commits = execSync(`git log --oneline ${range}`, { cwd: REPO_ROOT, encoding: "utf8" })
        .trim().split("\n").slice(0, 20);
      return {
        success: true,
        updated: false,
        check_only: true,
        behind,
        pending_commits: commits,
        message: `${behind} new upstream commit(s) available. Auto-apply is disabled by operator policy — review the diff and update manually (a blind git pull would also overwrite the local security patches).`,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      maxFeeActiveTvlRatio: ["screening", "maxFeeActiveTvlRatio"],
      minBaseFeePct: ["screening", "minBaseFeePct"],
      funnelStatsEnabled: ["screening", "funnelStatsEnabled"],
      funnelShadowEveryNCycles: ["screening", "funnelShadowEveryNCycles"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      useGmgnTrending: ["screening", "useGmgnTrending"],
      gmgnTrendingLimit: ["screening", "gmgnTrendingLimit"],
      useJupTrending: ["screening", "useJupTrending"],
      jupTrendingLimit: ["screening", "jupTrendingLimit"],
      jupTrendingInterval: ["screening", "jupTrendingInterval"],
      jupTrendingCategories: ["screening", "jupTrendingCategories"],
      jupTrendingCacheTtlSec: ["screening", "jupTrendingCacheTtlSec"],
      useDexScreener: ["screening", "useDexScreener"],
      dexScreenerLimit: ["screening", "dexScreenerLimit"],
      dexScreenerCategories: ["screening", "dexScreenerCategories"],
      dexScreenerCacheTtlSec: ["screening", "dexScreenerCacheTtlSec"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      botFilterReentryPct: ["screening", "botFilterReentryPct"],
      botFilterStrikeCount: ["screening", "botFilterStrikeCount"],
      botFilterStrikeWindowHours: ["screening", "botFilterStrikeWindowHours"],
      botFilterCooldownHours: ["screening", "botFilterCooldownHours"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      sweepEnabled: ["management", "sweepEnabled"],
      sweepMinUsd: ["management", "sweepMinUsd"],
      sweepExcludeMints: ["management", "sweepExcludeMints"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      maxHoldMinutes: ["management", "maxHoldMinutes"],
      maxHoldMinutesIfNegative: ["management", "maxHoldMinutesIfNegative"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      postCloseReentryCooldownMinutes: ["management", "postCloseReentryCooldownMinutes"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      hardTakeProfitPct: ["management", "hardTakeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      trailingBreakevenFloorPct: ["management", "trailingBreakevenFloorPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      // tx submission (priority fee + rebroadcast)
      txPriorityFeeMicroLamports: ["tx", "priorityFeeMicroLamports"],
      txPriorityFeeFloor: ["tx", "priorityFeeFloor"],
      txPriorityFeeCap: ["tx", "priorityFeeCap"],
      txConfirmTimeoutMs: ["tx", "confirmTimeoutMs"],
      txRebroadcastIntervalMs: ["tx", "rebroadcastIntervalMs"],
      txComputeUnitLimit: ["tx", "computeUnitLimit"],
      txCashMismatchTolerancePct: ["tx", "cashMismatchTolerancePct"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      pnlTakeProfitConfirmSec: ["pnl", "takeProfitConfirmSec"],
      // blind-window fix (era-8): flag applies live; busy interval needs restart
      pnlPollDuringCycles: ["pnl", "pollDuringCycles"],
      pnlBusyPollIntervalSec: ["pnl", "busyPollIntervalSec"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      smartWalletSizeBonusPct: ["management", "smartWalletSizeBonusPct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      screeningStartHourUtc: ["schedule", "screeningStartHourUtc"],
      screeningEndHourUtc: ["schedule", "screeningEndHourUtc"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      strategyMode: ["strategy", "strategyMode"],
      spotBinsThreshold: ["strategy", "spotBinsThreshold"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source", ["pnlSource"]],
      pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
      pnlReportSinceIso: ["pnl", "reportSinceIso", ["pnlReportSinceIso"]],
      pnlReportLlmUsdBaseline: ["pnl", "reportLlmUsdBaseline", ["pnlReportLlmUsdBaseline"]],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
      // gmgn fee source + trending source
      gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
      gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
      gmgnTrendingInterval: ["gmgn", "trendingInterval", ["gmgnTrendingInterval"]],
      gmgnTrendingOrderBy: ["gmgn", "trendingOrderBy", ["gmgnTrendingOrderBy"]],
      gmgnTrendingCacheTtlSec: ["gmgn", "trendingCacheTtlSec", ["gmgnTrendingCacheTtlSec"]],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
      // financial report / equity ledger
      reportSnapshotEnabled: ["report", "snapshotEnabled"],
      reportSnapshotCronUtc: ["report", "snapshotCronUtc"],
      reportWeeklyEnabled: ["report", "weeklyEnabled"],
      reportMonthlyEnabled: ["report", "monthlyEnabled"],
      reportLedgerRole: ["report", "ledgerRole"],
      reportLedgerDir: ["report", "ledgerDir"],
      reportRegistryPath: ["report", "registryPath"],
      reportWalkOverlapMin: ["report", "walkOverlapMin"],
      reportDriftToleranceSol: ["report", "driftToleranceSol"],
      reportPositionValuation: ["report", "positionValuation"],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    writeJsonAtomic(USER_CONFIG_PATH, userConfig);

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null || applied.reportSnapshotEnabled != null || applied.reportSnapshotCronUtc != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Swap a base token back to SOL with retry. Jupiter can transiently fail (no route,
 * quote error) and a single attempt silently leaves the token unsold — this retries
 * with a delay, re-fetching the balance each attempt (amounts can shift on partial
 * fills). Treats both a throw AND result.success===false / missing tx as failure.
 * Returns { swapped, result, token } — swapped=false if nothing to do or all attempts failed.
 */
async function swapBaseToSolWithRetry(baseMint, label) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastErr = null;
  let swapTried = false; // an actual swapToken call happened (balance may then legitimately empty)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find((t) => t.mint === baseMint);
      if (!token || token.usd < 0.10) {
        // Balance APIs can lag behind the close tx (step-2-light shortened the
        // post-close delay) — only conclude "nothing to swap" on the LAST
        // attempt, so a real bag that just isn't indexed yet still gets sold.
        // Genuine full-SOL exits simply spend the retries quietly. swapped is
        // only true if an earlier attempt really fired a swap (partial fill).
        if (attempt >= attempts) {
          return { swapped: swapTried, result: null, token: null };
        }
        lastErr = "base token not yet visible in balances (or dust)";
        await sleep(delayMs);
        continue;
      }
      swapTried = true;
      log("executor", `Auto-swapping ${label} ${token.symbol || baseMint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
      const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
      if (ok) return { swapped: true, result: swapResult, token };
      lastErr = swapResult?.error || swapResult?.reason || "swap returned no tx";
    } catch (e) {
      lastErr = e.message;
    }
    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${baseMint.slice(0, 8)})`);
  return { swapped: false, result: null, token: null };
}

// ─── Leftover-token sweep (fallback for the post-close auto-swap) ──────────
// The auto-swap above retries for ~40s and gives up — a network outage longer
// than that leaves the base token stranded in the wallet with only a local
// warning (9 Jul 2026: ~$275 of pendu after the ISP outage). Called every
// management cycle: any priced token above sweepMinUsd whose mint has no open
// position is swapped back to SOL. A mint must survive two consecutive scans
// before it is sold, so tokens passing through the wallet mid-deploy are never
// touched. Unpriced tokens (usd=null from Helius) are ignored — value unknown,
// and blind-selling scam airdrops burns gas on dead routes.
const _sweepSeen = new Set(); // mints seen last scan (in-memory; a restart just re-arms the 2-scan rule)
let _sweepBusy = false;

export async function sweepLeftoverTokens() {
  const m = config.management;
  if (!m.sweepEnabled || _sweepBusy) return { swept: [] };
  _sweepBusy = true;
  try {
    const minUsd = Math.max(0.1, Number(m.sweepMinUsd ?? 1));
    const exclude = new Set([
      config.tokens.SOL,
      config.tokens.USDC,
      config.tokens.USDT,
      ...(Array.isArray(m.sweepExcludeMints) ? m.sweepExcludeMints : []),
    ]);
    const [balances, myPositions] = await Promise.all([getWalletBalances({}), getMyPositions({})]);
    if (balances?.error) return { swept: [], error: balances.error }; // failed read — keep _sweepSeen as-is
    const openMints = new Set((myPositions?.positions || []).map((p) => p.base_mint).filter(Boolean));

    // normalizeMint collapses native-SOL aliases (Helius lists native SOL under a
    // So1… mint that differs from wrapped SOL) so SOL itself can never be a candidate
    const candidates = (balances.tokens || []).filter((t) =>
      t?.mint && !exclude.has(normalizeMint(t.mint)) && !openMints.has(t.mint) && Number(t.usd) >= minUsd
    );

    const current = new Set(candidates.map((t) => t.mint));
    for (const mint of _sweepSeen) if (!current.has(mint)) _sweepSeen.delete(mint);

    const swept = [];
    for (const token of candidates) {
      if (!_sweepSeen.has(token.mint)) {
        _sweepSeen.add(token.mint);
        log("sweep", `Leftover token noted: ${token.symbol} ($${Number(token.usd).toFixed(2)}, no open position) — sweeping next cycle if still present`);
        continue;
      }
      log("sweep", `Sweeping leftover ${token.symbol} ($${Number(token.usd).toFixed(2)}) back to SOL`);
      const { swapped, result } = await swapBaseToSolWithRetry(token.mint, "sweep");
      if (swapped) {
        _sweepSeen.delete(token.mint);
        swept.push({ mint: token.mint, symbol: token.symbol, usd: Number(token.usd) });
        if (result) {
          notifySwap({ inputSymbol: token.symbol, outputSymbol: "SOL", amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
        }
      } else {
        // Stays in _sweepSeen — retried next management cycle. Alert so a stuck
        // token is no longer log-only (the pendu failure mode).
        sendMessage(`⚠️ Sweep failed: ${token.symbol} ($${Number(token.usd).toFixed(2)}) is still in the wallet with no open position — will retry next cycle. Check logs.`).catch(() => {});
      }
    }
    return { swept };
  } finally {
    _sweepBusy = false;
  }
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        if (!args.skip_swap && result.base_mint) {
          const { swapped, result: swapResult, token } = await swapBaseToSolWithRetry(result.base_mint, "after close");
          if (swapped) {
            // Tell the model the swap already happened so it doesn't call swap_token again
            result.auto_swapped = true;
            result.auto_swap_note = `Base token already auto-swapped back to SOL (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
          }
          // Exit-slippage instrumentation (step 1): merge swap-side execution data into
          // the performance entry recordPerformance wrote inside closePosition. The swap
          // runs after that record exists, so this back-fills `exit_execution`.
          try {
            const posAddr = result.position || args.position_address;
            if (posAddr) {
              // Step-2-light: recordPerformance now runs async inside closePosition —
              // wait for it so the performance entry exists before attaching.
              await waitForCloseBookkeeping(posAddr);
              const t = result.close_timing || {};
              const quoteOutSol = swapResult?.quote_out_amount != null ? Number(swapResult.quote_out_amount) / 1e9 : null;
              const execOutSol = swapResult?.amount_out != null ? Number(swapResult.amount_out) / 1e9 : null;
              const msBetween = (a, b) => (a && b) ? new Date(b).getTime() - new Date(a).getTime() : null;
              attachExitExecution(posAddr, {
                ...t,
                swap_quoted_at: swapResult?.quoted_at ?? null,
                swap_executed_at: swapResult?.executed_at ?? null,
                close_to_quote_ms: msBetween(t.close_done_at, swapResult?.quoted_at),
                signal_to_swap_done_ms: msBetween(t.signal_at, swapResult?.executed_at),
                token_amount: token?.balance ?? null,
                token_usd_at_swap: token?.usd ?? null,
                quote_price_impact_pct: swapResult?.quote_price_impact_pct ?? null,
                quote_slippage_bps: swapResult?.quote_slippage_bps ?? null,
                quote_in_usd: swapResult?.quote_in_usd ?? null,
                quote_out_usd: swapResult?.quote_out_usd ?? null,
                quote_out_sol: quoteOutSol,
                exec_out_sol: execOutSol,
                exec_vs_quote_pct: (quoteOutSol && execOutSol != null)
                  ? Math.round(((execOutSol - quoteOutSol) / quoteOutSol) * 10000) / 100
                  : null,
                swap_tx: swapResult?.tx ?? null,
                swap_attempted: !!swapResult,
                swap_success: !!swapped,
              });

              // On-chain cash reconciliation (step 3). Fire-and-forget: it needs
              // the signatures to be queryable, which can lag a beat, and nothing
              // downstream waits on it. Deploy signatures come from state.json —
              // recorded at deploy time, never inferred from a timestamp window.
              const trackedPos = getTrackedPosition(posAddr);
              const deployTxs = trackedPos?.deploy_txs || [];
              // Union of what THIS call returned and every close/claim signature
              // ever submitted for the position (state.close_tx_attempts). A close
              // that timed out and was retried reports only the retry's signature;
              // the txs that landed on the first attempt live in state alone, and
              // leaving them out is what booked -8.3 SOL of phantom losses in era #9.
              const closeTxs = [...new Set([
                ...(result.close_txs || []),
                ...(result.close_tx_attempts || []),
                ...(trackedPos?.close_tx_attempts || []),
              ])];
              // Meteora's own settled numbers, for the independent cross-check.
              const perfEntry = getPerformanceEntry(posAddr);
              void reconcileCycleCash({
                deploy_txs: deployTxs,
                claim_txs: result.claim_txs || [],
                close_txs: closeTxs,
                swap_tx: swapResult?.tx ?? null,
                withdrawals_sol: perfEntry?.withdrawals_sol ?? null,
                deposits_sol: perfEntry?.deposits_sol ?? trackedPos?.amount_sol ?? null,
              })
                .then((cash) => {
                  attachExitExecution(posAddr, cash);
                  if (!cash.cash_complete) {
                    // Positions deployed before deploy_txs existed have no
                    // outflow to measure — expected once, not a fault.
                    const why = cash.cash_mismatch_over_tolerance
                      ? (cash.cash_mismatch_direction === "shortfall"
                        ? `kurang ${Math.abs(cash.cash_mismatch_sol)} SOL vs withdrawals Meteora (>${cash.cash_mismatch_tolerance_pct}% deposit) — ada signature close yang hilang`
                        : `lebih ${cash.cash_mismatch_sol} SOL vs withdrawals Meteora — di luar yang bisa dijelaskan refund rent`)
                      : deployTxs.length
                        ? `${cash.cash_txs_missing} tx tak terbaca`
                        : "posisi lama, deploy_txs belum terekam";
                    log("executor_warn", `Cash recon incomplete for ${posAddr.slice(0, 8)}: ${why}`);
                  }
                })
                .catch((e) => log("executor_warn", `Cash recon failed: ${e.message}`));
            }
          } catch (e) {
            log("executor_warn", `Exit-exec instrumentation failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (countablePositions(positions) >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        // SOL number only — an RPC getBalance (~1 credit) instead of the Wallet
        // API (100). A failed read yields 0, which refuses the deploy exactly as
        // the old error path did (getWalletBalances returned sol: 0 on failure).
        const solBalance = (await getSolBalance()) ?? 0;
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (solBalance < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${solBalance} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
