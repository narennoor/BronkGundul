/**
 * Bot-filter hysteresis — persistent memory for the Jupiter bot-holders screening filter.
 *
 * The plain `botPct > maxBotHoldersPct` check is memoryless: bot_holders_pct is a noisy
 * sample, and a borderline token that keeps appearing as a candidate gets re-sampled
 * every screening cycle until one dip slips under the threshold (SalaryCat entered at
 * 31.92% after dozens of rejections at 33-52% and cost -$104; Nongwan same pattern).
 *
 * Three mechanisms, all per base mint:
 *   1. Hysteresis band — once a mint has been rejected for bots, it must show
 *      botPct < botFilterReentryPct (lower than the reject threshold) to pass again.
 *   2. Strike counter — botFilterStrikeCount rejections within botFilterStrikeWindowHours
 *      put the mint on a botFilterCooldownHours cooldown.
 *   3. The cooldown is also consulted pre-recon in getTopCandidates so a cooling mint
 *      doesn't burn recon API calls or occupy one of the 10 candidate slots.
 *
 * A pass under the effective threshold clears the mint's record entirely.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { writeJsonAtomic } from "./utils/json-store.js";

const BOT_FILTER_FILE = process.env.BOT_FILTER_STORE || repoPath("bot-filter-memory.json");
const STALE_ENTRY_MS = 7 * 24 * 60 * 60 * 1000; // drop records not struck for a week

function load() {
  if (!fs.existsSync(BOT_FILTER_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BOT_FILTER_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  writeJsonAtomic(BOT_FILTER_FILE, data);
}

function sanitizeName(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[\r\n\t]+/g, " ").replace(/[<>`]/g, "").trim().slice(0, 64);
  return cleaned || null;
}

function pruneStale(db, now) {
  let changed = false;
  for (const [mint, entry] of Object.entries(db)) {
    const onCooldown = entry?.cooldown_until && new Date(entry.cooldown_until) > now;
    const lastStrike = entry?.last_strike_at ? new Date(entry.last_strike_at).getTime() : 0;
    if (!onCooldown && now.getTime() - lastStrike > STALE_ENTRY_MS) {
      delete db[mint];
      changed = true;
    }
  }
  return changed;
}

/** Cheap pre-recon check for getTopCandidates — no writes. */
export function isBotFilterMintOnCooldown(mint) {
  if (!mint) return false;
  const entry = load()[mint];
  return !!(entry?.cooldown_until && new Date(entry.cooldown_until) > new Date());
}

/**
 * Evaluate the bot-holders filter for one candidate and record the outcome.
 * @param {object} p — { mint, name, botPct }
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function evaluateBotFilter({ mint, name, botPct } = {}) {
  const limit = config.screening.maxBotHoldersPct;
  const pct = Number(botPct);
  // No data or filter disabled — behave exactly like the old check (pass).
  if (limit == null || botPct == null || !Number.isFinite(pct)) return { allowed: true, reason: null };

  // Without a mint we can't keep memory — fall back to the plain threshold.
  if (!mint) {
    return pct > limit
      ? { allowed: false, reason: `bot holders ${pct}% > ${limit}%` }
      : { allowed: true, reason: null };
  }

  const now = new Date();
  const db = load();
  const stalePruned = pruneStale(db, now);
  const entry = db[mint];

  const reentryPct = config.screening.botFilterReentryPct;
  const strikeCount = config.screening.botFilterStrikeCount;
  const windowMs = (config.screening.botFilterStrikeWindowHours || 0) * 3600 * 1000;
  const cooldownMs = (config.screening.botFilterCooldownHours || 0) * 3600 * 1000;

  // Active cooldown — reject without stacking further strikes.
  if (entry?.cooldown_until && new Date(entry.cooldown_until) > now) {
    entry.last_bot_pct = pct;
    save(db);
    return {
      allowed: false,
      reason: `bot-filter cooldown until ${entry.cooldown_until} (${entry.strikes} strikes, last ${pct}%)`,
    };
  }

  // Hysteresis band: a previously-struck mint must dip under the (lower) re-entry
  // threshold, not just under the reject threshold.
  const flagged = !!entry && entry.strikes > 0;
  const effectiveLimit = flagged && reentryPct != null && reentryPct > 0 ? Math.min(limit, reentryPct) : limit;

  if (pct <= effectiveLimit) {
    // Clean pass — the token proved itself; forget its record.
    if (entry) {
      delete db[mint];
      save(db);
      log("screening", `Bot-filter: ${name || mint.slice(0, 8)} cleared (${pct}% <= ${effectiveLimit}%)`);
    } else if (stalePruned) {
      save(db);
    }
    return { allowed: true, reason: null };
  }

  // Strike. Reset the counter if the last strike fell out of the rolling window.
  const next = entry || { name: sanitizeName(name), strikes: 0, first_strike_at: now.toISOString() };
  if (windowMs > 0 && next.last_strike_at && now.getTime() - new Date(next.last_strike_at).getTime() > windowMs) {
    next.strikes = 0;
    next.first_strike_at = now.toISOString();
  }
  next.strikes += 1;
  next.last_strike_at = now.toISOString();
  next.last_bot_pct = pct;
  if (name) next.name = sanitizeName(name);

  let reason = flagged
    ? `bot holders ${pct}% > re-entry ${effectiveLimit}% (hysteresis, strike ${next.strikes})`
    : `bot holders ${pct}% > ${limit}% (strike ${next.strikes})`;

  if (strikeCount > 0 && cooldownMs > 0 && next.strikes >= strikeCount) {
    next.cooldown_until = new Date(now.getTime() + cooldownMs).toISOString();
    reason = `bot holders ${pct}% — ${next.strikes} strikes, cooldown ${config.screening.botFilterCooldownHours}h`;
    log("screening", `Bot-filter: ${next.name || mint.slice(0, 8)} on cooldown until ${next.cooldown_until} (${next.strikes} strikes)`);
  }

  db[mint] = next;
  save(db);
  return { allowed: false, reason };
}

/** Summary for ops surfaces (Telegram /status, debugging). */
export function getBotFilterSummary() {
  const now = new Date();
  const entries = Object.entries(load()).map(([mint, e]) => ({
    mint,
    name: e.name || null,
    strikes: e.strikes,
    last_bot_pct: e.last_bot_pct ?? null,
    cooldown_until: e.cooldown_until && new Date(e.cooldown_until) > now ? e.cooldown_until : null,
  }));
  return { tracked: entries.length, entries };
}
