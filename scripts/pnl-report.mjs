// CLI wrapper: node scripts/pnl-report.mjs
// Prints the full PnL report (bookkeeping → execution cost → real on-chain cash).
import { loadEnv } from "../envcrypt.js";

loadEnv();

const { computePnlReport, formatPnlReport } = await import("../pnl-report.js");

try {
  const report = await computePnlReport();
  console.log(formatPnlReport(report));
} catch (e) {
  console.error(`PnL report failed: ${e.message}`);
  process.exit(1);
}
