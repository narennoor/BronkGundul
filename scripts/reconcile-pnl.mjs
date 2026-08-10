// CLI wrapper.
//
//   node scripts/reconcile-pnl.mjs [--lookback <hours>] [--force] [--dry-run]
//     Re-fetches settled closed-PnL records from the Meteora datapi and patches
//     lessons.json / pool-memory.json bookkeeping. Use a large --lookback for
//     historical backfill (e.g. --lookback 720 covers ~30 days).
//
//   node scripts/reconcile-pnl.mjs --recheck-cash [--positions a,b,c]
//                                  [--lookback <hours>] [--all] [--dry-run]
//     Rebuilds sol_cycle_net from the chain by walking each position account's
//     own signature history, instead of trusting the signatures the close path
//     managed to hand over. With no --positions it recomputes every close in
//     the window whose measured inflow disagrees with Meteora's withdrawals by
//     more than 1% of the deposit; --all recomputes the window regardless.
import { loadEnv } from "../envcrypt.js";

loadEnv();

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const lookbackHours = parseFloat(flagValue("--lookback") ?? "") || (argv.includes("--recheck-cash") ? 168 : 48);
const force = argv.includes("--force");
const dryRun = argv.includes("--dry-run");

if (argv.includes("--recheck-cash")) {
  const { recheckCash } = await import("../pnl-reconciler.js");
  const positions = (flagValue("--positions") || "").split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const result = await recheckCash({ positions, lookbackHours, dryRun, all: argv.includes("--all") });
    console.log(`Rechecked ${result.checked} close(s), patched ${result.patched}.${dryRun ? " [DRY RUN — nothing written]" : ""}`);
    for (const p of result.patches) {
      const sign = (n) => (n >= 0 ? "+" : "");
      console.log(
        `  ${p.recorded_at.slice(0, 16)}  ${(p.pool_name || p.position.slice(0, 8)).padEnd(16)}` +
        `  sol_cycle_net ${sign(p.before ?? 0)}${p.before} → ${sign(p.after)}${p.after}  (${sign(p.delta)}${p.delta}, ${p.txs} tx)`,
      );
    }
    if (result.patched > 0) {
      console.log(`Net correction: ${result.totalDelta >= 0 ? "+" : ""}${result.totalDelta} SOL`);
    }
  } catch (e) {
    console.error(`Recheck-cash failed: ${e.message}`);
    process.exit(1);
  }
} else {
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
}
