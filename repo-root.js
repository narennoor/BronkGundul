import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Meridian repo root — stable under PM2, npm start, and CLI. */
export const REPO_ROOT = __dirname;

/**
 * Where the JSON data files (state.json, lessons.json, user-config.json, logs/, …)
 * live. Defaults to the repo root. MERIDIAN_STATE_DIR redirects every repoPath()
 * consumer to an alternate directory — the unit-test suite sets it to a temp dir
 * (unit-tests/_setup.mjs) so tests can never touch the live files (18 Aug 2026
 * incident: phantom UNITTEST positions leaked into production state.json).
 * REPO_ROOT itself is NOT affected — it keeps pointing at the code checkout.
 */
export const STATE_DIR = process.env.MERIDIAN_STATE_DIR
  ? path.resolve(process.env.MERIDIAN_STATE_DIR)
  : REPO_ROOT;

export function repoPath(...segments) {
  return path.join(STATE_DIR, ...segments);
}
