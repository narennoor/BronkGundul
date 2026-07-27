/**
 * Test bot-filter hysteresis logic (no network, no wallet).
 * Run: node test/test-bot-filter.js
 */

import os from "os";
import path from "path";
import fs from "fs";

process.env.BOT_FILTER_STORE = path.join(os.tmpdir(), `bot-filter-test-${process.pid}.json`);

const { evaluateBotFilter, isBotFilterMintOnCooldown, getBotFilterSummary } = await import("../bot-filter.js");
const { config } = await import("../config.js");

config.screening.maxBotHoldersPct = 33;
config.screening.botFilterReentryPct = 25;
config.screening.botFilterStrikeCount = 3;
config.screening.botFilterStrikeWindowHours = 12;
config.screening.botFilterCooldownHours = 6;

const MINT = "SaLaryCatTestMint111111111111111111111111111";
let failed = 0;

function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failed++;
}

// 1. Clean token passes and leaves no record
let r = evaluateBotFilter({ mint: MINT, name: "CLEAN-SOL", botPct: 20 });
check("clean pass at 20%", r.allowed);
check("clean pass leaves no record", getBotFilterSummary().tracked === 0);

// 2. First rejection = strike 1
r = evaluateBotFilter({ mint: MINT, name: "SalaryCat-SOL", botPct: 41.3 });
check("41.3% rejected (strike 1)", !r.allowed && r.reason.includes("strike 1"));

// 3. THE SalaryCat case: noise-dip to 31.9% — under 33 but above re-entry 25 → still rejected
r = evaluateBotFilter({ mint: MINT, name: "SalaryCat-SOL", botPct: 31.9 });
check("31.9% after a strike rejected by hysteresis band", !r.allowed && r.reason.includes("hysteresis"));

// 4. Third strike triggers the cooldown
r = evaluateBotFilter({ mint: MINT, name: "SalaryCat-SOL", botPct: 32.5 });
check("third strike sets cooldown", !r.allowed && r.reason.includes("cooldown"));
check("isBotFilterMintOnCooldown true", isBotFilterMintOnCooldown(MINT));

// 5. During cooldown even a great sample is rejected
r = evaluateBotFilter({ mint: MINT, name: "SalaryCat-SOL", botPct: 10 });
check("10% during cooldown still rejected", !r.allowed && r.reason.includes("cooldown"));

// 6. After cooldown expires, a sample under re-entry clears the record
const db = JSON.parse(fs.readFileSync(process.env.BOT_FILTER_STORE, "utf8"));
db[MINT].cooldown_until = new Date(Date.now() - 1000).toISOString();
fs.writeFileSync(process.env.BOT_FILTER_STORE, JSON.stringify(db));
r = evaluateBotFilter({ mint: MINT, name: "SalaryCat-SOL", botPct: 24 });
check("24% after cooldown passes (under re-entry 25)", r.allowed);
check("record cleared after clean pass", getBotFilterSummary().tracked === 0);

// 7. Post-clear, band is gone: 30% passes again like a fresh token
r = evaluateBotFilter({ mint: MINT, name: "SalaryCat-SOL", botPct: 30 });
check("30% passes once record cleared", r.allowed);

// 8. Fallbacks: no data / no mint behave like the old plain check
check("null botPct passes", evaluateBotFilter({ mint: MINT, name: "X", botPct: null }).allowed);
check("no mint, over limit rejected", !evaluateBotFilter({ name: "X", botPct: 50 }).allowed);
check("no mint, under limit passes", evaluateBotFilter({ name: "X", botPct: 20 }).allowed);

fs.rmSync(process.env.BOT_FILTER_STORE, { force: true });
console.log(failed === 0 ? "\nAll bot-filter tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
