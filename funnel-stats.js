/**
 * Funnel stats — kill-count instrumentation for the screening funnel.
 *
 * Records, per filter, how many pools it kills and how many it *uniquely*
 * kills (pool failed only that one filter — i.e. relaxing it would admit
 * the pool). Unique kills are the number that matters for tuning; raw kills
 * overcount because one pool can fail five filters at once.
 *
 * Two sections:
 *  - client: every getTopCandidates cycle, all client-side checks evaluated
 *    observe-all (no short-circuit) on pools that arrived client-side.
 *    Cooldown checks are the exception — they are expensive (file reads) and
 *    only evaluated for pools passing everything else, so their kills are
 *    always unique kills by construction.
 *  - shadow: every funnelShadowEveryNCycles screening cycles, one discovery
 *    call with a minimal query (pool_type + volume baseline) and ALL config
 *    thresholds applied client-side — this is the only way to attribute
 *    kills for filters normally enforced server-side in the API query
 *    (minMcap/maxMcap, minHolders, bin step, fee band, organic, age).
 *
 * Pure observability: never changes which pools pass. Zero LLM tokens.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { writeJsonAtomic } from "./utils/json-store.js";

const FUNNEL_STATS_FILE = repoPath("funnel-stats.json");

function emptySection() {
  return { cycles: 0, pools_seen: 0, passed: 0, last_run_at: null, filters: {} };
}

function load() {
  if (!fs.existsSync(FUNNEL_STATS_FILE)) {
    return { since: new Date().toISOString(), client: emptySection(), shadow: emptySection() };
  }
  try {
    const db = JSON.parse(fs.readFileSync(FUNNEL_STATS_FILE, "utf8"));
    db.client = db.client || emptySection();
    db.shadow = db.shadow || emptySection();
    return db;
  } catch (error) {
    log("funnel", `Failed to read funnel stats, starting fresh: ${error.message}`);
    return { since: new Date().toISOString(), client: emptySection(), shadow: emptySection() };
  }
}

function save(data) {
  writeJsonAtomic(FUNNEL_STATS_FILE, data);
}

/**
 * Record one funnel evaluation pass.
 *
 * @param {"client"|"shadow"} section
 * @param {number} poolsSeen   total pools evaluated this pass
 * @param {number} passed      pools that passed every filter
 * @param {string[][]} failuresByPool  one entry per killed pool: the names of ALL filters it failed
 */
export function recordFunnelCycle(section, { poolsSeen, passed, failuresByPool }) {
  const db = load();
  const s = db[section];
  s.cycles += 1;
  s.pools_seen += poolsSeen;
  s.passed += passed;
  s.last_run_at = new Date().toISOString();
  for (const failures of failuresByPool) {
    const unique = failures.length === 1;
    for (const name of failures) {
      const rec = (s.filters[name] = s.filters[name] || { kills: 0, unique_kills: 0 });
      rec.kills += 1;
      if (unique) rec.unique_kills += 1;
    }
  }
  save(db);
  return db;
}

export function getFunnelStats() {
  return load();
}

const FUNNEL_HISTORY_FILE = repoPath("funnel-stats-history.json");

/**
 * Era rotation: archive the current counters to funnel-stats-history.json and
 * start fresh with an era label. Counters that span a config change are
 * unattributable (the era-7 review could not slice 16k cycles back to eras),
 * so every era flip should rotate. Called from scripts/rotate-funnel-stats.mjs
 * at era start — the daemon never calls this. Safe against a live daemon:
 * recordFunnelCycle round-trips the whole object, so the era field survives
 * its writes; the ops script verifies the reset landed.
 */
export function rotateFunnelStats(eraLabel) {
  if (!eraLabel || typeof eraLabel !== "string") throw new Error("rotateFunnelStats needs an era label");
  const db = load();
  let history = [];
  try {
    if (fs.existsSync(FUNNEL_HISTORY_FILE)) history = JSON.parse(fs.readFileSync(FUNNEL_HISTORY_FILE, "utf8"));
  } catch { /* corrupt history never blocks a rotation — start a new one */ }
  history.push({ era: db.era ?? null, since: db.since, archived_at: new Date().toISOString(), client: db.client, shadow: db.shadow });
  writeJsonAtomic(FUNNEL_HISTORY_FILE, history);
  const fresh = { era: eraLabel, since: new Date().toISOString(), client: emptySection(), shadow: emptySection() };
  save(fresh);
  return fresh;
}

/** Compact one-line summary for logs: top killers by unique kills. */
export function summarizeFunnel(section = "client", topN = 4) {
  const db = load();
  const s = db[section];
  const tag = db.era ? `${section}@${db.era}` : section;
  if (!s || s.cycles === 0) return `${tag}: no data`;
  const top = Object.entries(s.filters)
    .sort((a, b) => b[1].unique_kills - a[1].unique_kills || b[1].kills - a[1].kills)
    .slice(0, topN)
    .map(([name, r]) => `${name}=${r.unique_kills}u/${r.kills}k`)
    .join(", ");
  return `${tag}: ${s.cycles} cycles, ${s.pools_seen} seen, ${s.passed} passed | top: ${top}`;
}
