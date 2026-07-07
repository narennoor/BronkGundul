import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";

// ── Server-response sanitizers ──────────────────────────────────────
// Everything this module returns ends up in LLM prompts. Server strings are
// never passed through raw: owners must be base58, labels are reduced to a
// single lowercase token, names are stripped of markup/newlines and capped.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function safeOwner(value) {
  const s = String(value || "").trim();
  return BASE58_RE.test(s) ? s : null;
}

function safeLabel(value, maxLen = 24) {
  if (typeof value !== "string") return null;
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+\-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
  return s || null;
}

function safeName(value, maxLen = 48) {
  if (typeof value !== "string") return null;
  const s = value
    .replace(/[\r\n\t<>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return s || null;
}

export async function studyTopLPers({ pool_address, limit = 4 }) {
  const [poolRes, signalRes] = await Promise.all([
    fetchTopLp(pool_address),
    fetchStudyTopLp(pool_address),
  ]);

  const poolData = poolRes;
  const signalData = signalRes;
  const topLpers = Array.isArray(poolData.topLpers) ? poolData.topLpers : [];
  const historicalOwners = Array.isArray(poolData.historicalOwners) ? poolData.historicalOwners : [];
  const ranked = topLpers.slice(0, Math.max(1, limit));

  if (!ranked.length) {
    return {
      pool: pool_address,
      message: "No LPAgent top LPer data found for this pool yet.",
      patterns: {},
      lpers: [],
    };
  }

  const historicalMap = new Map(historicalOwners.map((owner) => [owner.owner, owner]));

  const lpers = ranked.map((owner) => {
    const ownerAddress = safeOwner(owner.owner);
    if (!ownerAddress) return null; // untrusted row — owner must be a valid base58 address
    const history = historicalMap.get(owner.owner);
    const preferredStrategy = safeLabel(history?.preferredStrategy);
    const preferredRangeStyle = safeLabel(history?.preferredRangeStyle);
    return {
      owner: ownerAddress,
      owner_short: `${ownerAddress.slice(0, 8)}...`,
      signal_tags: [
        preferredStrategy ? `strategy:${preferredStrategy}` : null,
        preferredRangeStyle ? `range:${preferredRangeStyle}` : null,
      ].filter(Boolean),
      summary: {
        total_positions: owner.totalLp || history?.topPositions?.length || 0,
        avg_hold_hours: round(owner.avgAgeHours ?? history?.avgHoldHours ?? 0, 2),
        avg_open_pnl_pct: round(owner.pnlPerInflowPct ?? history?.avgPnlPct ?? 0, 2),
        avg_fee_per_tvl_24h_pct: round(owner.feePercent ?? history?.avgFeePercent ?? 0, 2),
        total_pnl_usd: round(owner.totalPnlUsd ?? 0, 2),
        total_balance_usd: round(owner.totalInflowUsd ?? 0, 2),
        avg_range_width_pct: null,
        avg_distance_to_active_pct: null,
        win_rate: round((owner.winRatePct ?? 0) / 100, 2),
        roi: round((owner.roiPct ?? 0) / 100, 4),
        fee_pct_of_capital: round(owner.feePercent ?? 0, 2),
        preferred_strategy: preferredStrategy || "unknown",
        preferred_range_style: preferredRangeStyle || "unknown",
      },
      positions: Array.isArray(history?.topPositions)
        ? history.topPositions.map((position) => ({
            pool: pool_address,
            pair: safeName(poolData.overview?.name) || "Unknown pool",
            hold_hours: round(position.ageHours ?? 0, 2),
            pnl_usd: round(position.pnlUsd ?? 0, 2),
            pnl_pct: fmtPct(position.pnlPct),
            fee_usd: round(position.feeUsd ?? 0, 2),
            in_range_pct: position.inRange == null ? null : position.inRange ? 100 : 0,
            strategy: safeLabel(position.strategy),
            closed_reason: safeLabel(position.rangeStyle),
            balance_usd: round(position.inputValue ?? 0, 2),
            fee_per_tvl_24h_pct: round(position.feePercent ?? 0, 2),
            range_width_pct: position.widthBins ?? null,
            distance_to_active_pct: null,
            lower_bin_id: position.lowerBinId ?? null,
            upper_bin_id: position.upperBinId ?? null,
          }))
        : [],
    };
  });

  const sanitizedLpers = lpers.filter(Boolean);

  const patterns = buildPatterns(ranked, historicalOwners, signalData, poolData.overview || {});

  return {
    pool: pool_address,
    pool_name:
      safeName(poolData.overview?.name) ||
      `${safeName(poolData.overview?.tokenXSymbol, 16) || "TOKEN"}-${safeName(poolData.overview?.tokenYSymbol, 16) || "SOL"}`,
    message:
      "LPAgent-backed top LP study from Agent Meridian 30m cached owner aggregates plus owner historical positions.",
    patterns,
    lpers: sanitizedLpers,
  };
}

function fetchTopLp(poolAddress) {
  return agentMeridianJson(`/top-lp/${poolAddress}`, {
    headers: getAgentMeridianHeaders(),
  });
}

function fetchStudyTopLp(poolAddress) {
  return agentMeridianJson(`/study-top-lp/${poolAddress}`, {
    headers: getAgentMeridianHeaders(),
  });
}

function buildPatterns(ranked, historicalOwners, signalData, overview) {
  const avgHold = avg(ranked.map((o) => o.avgAgeHours).filter(isNum));
  const avgOpenPnlPct = avg(ranked.map((o) => o.pnlPerInflowPct).filter(isNum));
  const avgFeePct = avg(ranked.map((o) => o.feePercent).filter(isNum));
  const avgRoiPct = avg(ranked.map((o) => o.roiPct).filter(isNum));
  const preferredStrategies = countValues(historicalOwners.map((o) => safeLabel(o.preferredStrategy)).filter(Boolean));
  const preferredRanges = countValues(historicalOwners.map((o) => safeLabel(o.preferredRangeStyle)).filter(Boolean));

  return {
    top_lper_count: ranked.length,
    study_mode: "lpagent_top_lpers",
    pool_name:
      safeName(overview.name) || `${safeName(overview.tokenXSymbol, 16) || "TOKEN"}-${safeName(overview.tokenYSymbol, 16) || "SOL"}`,
    active_position_count: signalData.activePositionCount ?? ranked.length,
    owner_count: signalData.ownerCount ?? ranked.length,
    avg_hold_hours: round(avgHold, 2),
    avg_open_pnl_pct: round(avgOpenPnlPct, 2),
    avg_fee_percent: round(avgFeePct, 2),
    avg_roi_pct: round(avgRoiPct, 2),
    best_open_pnl_pct: ranked[0] ? `${round(ranked[0].pnlPerInflowPct || 0, 2)}%` : null,
    scalper_count: ranked.filter((o) => (o.avgAgeHours || 0) < 1).length,
    holder_count: ranked.filter((o) => (o.avgAgeHours || 0) >= 4).length,
    preferred_strategies: preferredStrategies,
    preferred_range_styles: preferredRanges,
    // raw server objects are never passed through — reduced to typed fields
    top_historical_owners: (signalData.topHistoricalOwners || [])
      .slice(0, 3)
      .map((o) => ({
        owner: safeOwner(o?.owner),
        preferred_strategy: safeLabel(o?.preferredStrategy),
        avg_pnl_pct: round(o?.avgPnlPct, 2),
        avg_hold_hours: round(o?.avgHoldHours, 2),
      }))
      .filter((o) => o.owner),
    suggested_style: safeLabel(signalData.suggestedStyle),
  };
}

function countValues(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function isNum(value) {
  return Number.isFinite(Number(value));
}

function fmtPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${round(n, 2)}%`;
}
