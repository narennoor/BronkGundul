// Shared unit-test setup — MUST be the first import of every *.test.mjs file.
//
// Sets MERIDIAN_STATE_DIR to a fresh temp directory BEFORE any production
// module is evaluated, so every repoPath() consumer (state.js, lessons.js,
// pool-memory.js, decision-log.js, signal-weights.js, config.js, logger.js, …)
// reads and writes there instead of the repo root. The live JSON files are
// never opened, so the suite cannot race a running daemon (18 Aug 2026
// incident: the old byte-snapshot/restore of state.json raced the pm2 daemon's
// load+save loop and leaked 22 phantom UNITTEST positions into production).
//
// Being an import (not an npm-script env var) means isolation also holds when
// a single file is run directly: node --test unit-tests/foo.test.mjs
//
// MERIDIAN_STATE_DIR may be pre-set to inspect the files a run leaves behind;
// a pre-made dir is kept after the run, an auto-created one is removed on exit.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

process.env.LOG_LEVEL ||= "error";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let created = false;
if (!process.env.MERIDIAN_STATE_DIR) {
  process.env.MERIDIAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-unittest-"));
  created = true;
}

export const STATE_DIR = path.resolve(process.env.MERIDIAN_STATE_DIR);

// Belt and braces: refuse to run against the live data directory, ever.
if (STATE_DIR === REPO_ROOT) {
  throw new Error(
    "unit-tests/_setup.mjs: MERIDIAN_STATE_DIR points at the repo root — " +
    "running the unit tests against the live state.json races the daemon " +
    "(18 Aug 2026 incident). Unset it or point it at a scratch directory.",
  );
}

export function statePath(...segments) {
  return path.join(STATE_DIR, ...segments);
}

// The equity ledger (equity-snapshot.js) deliberately bypasses repoPath() —
// it lives in ~/.meridian/ledger so both daemons write where one consolidator
// reads — so MERIDIAN_STATE_DIR alone does NOT isolate it. Point it into the
// same temp tree (removed together on exit) so a test can never touch the
// real ledger.
if (!process.env.MERIDIAN_LEDGER_DIR) {
  process.env.MERIDIAN_LEDGER_DIR = path.join(STATE_DIR, "ledger");
}

export const LEDGER_DIR = path.resolve(process.env.MERIDIAN_LEDGER_DIR);

if (LEDGER_DIR === path.join(os.homedir(), ".meridian", "ledger")) {
  throw new Error(
    "unit-tests/_setup.mjs: MERIDIAN_LEDGER_DIR menunjuk ledger sungguhan " +
    "(~/.meridian/ledger) — unset atau arahkan ke direktori scratch.",
  );
}

export function ledgerPath(...segments) {
  return path.join(LEDGER_DIR, ...segments);
}

if (created) {
  process.on("exit", () => {
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
  });
}
