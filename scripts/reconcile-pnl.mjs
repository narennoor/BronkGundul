// CLI wrapper: node scripts/reconcile-pnl.mjs [--lookback <hours>] [--force] [--dry-run]
// Re-fetches settled closed-PnL records from the Meteora datapi and patches
// lessons.json / pool-memory.json bookkeeping. Use a large --lookback for
// historical backfill (e.g. --lookback 720 covers ~30 days).
import { loadEnv } from "../envcrypt.js";

loadEnv();

const argv = process.argv.slice(2);
const lookbackIdx = argv.indexOf("--lookback");
const lookbackHours = lookbackIdx >= 0 ? parseFloat(argv[lookbackIdx + 1]) : 48;
const force = argv.includes("--force");
const dryRun = argv.includes("--dry-run");

const { reconcileClosedPnl } = await import("../pnl-reconciler.js");

try {
  const result = await reconcileClosedPnl({ lookbackHours, force, dryRun });
  console.log(`Checked ${result.checked} close(s), patched ${result.patched}, flagged ${result.flagged}.`);
  if (result.patched > 0) {
    console.log(`Net bookkeeping delta: ${result.totalDelta >= 0 ? "+" : ""}$${result.totalDelta.toFixed(2)}`);
    for (const p of result.patches) {
      console.log(`  ${p.recorded_at}  ${p.position.slice(0, 8)}  ${p.delta >= 0 ? "+" : ""}$${p.delta.toFixed(2)} -> $${p.pnl_usd.toFixed(2)}`);
    }
  }
} catch (e) {
  console.error(`Reconcile failed: ${e.message}`);
  process.exit(1);
}
