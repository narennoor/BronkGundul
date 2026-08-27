// CLI wrapper: node scripts/equity-snapshot.mjs
// Takes (or backfills) the daily equity snapshot for this wallet's ledger at
// ~/.meridian/ledger/<address>/snapshots.json. Safe to run next to a live
// daemon: it only READS state.json / lessons.json and only WRITES the ledger.
// Idempotent — a snapshot that already exists for today is left untouched.
//
// Point MERIDIAN_STATE_DIR at the daemon's data dir when running from a
// worktree, e.g.:
//   MERIDIAN_STATE_DIR=$HOME/BronkGundul node scripts/equity-snapshot.mjs
import { loadEnv } from "../envcrypt.js";

loadEnv();

const { takeSnapshot } = await import("../equity-snapshot.js");

try {
  const res = await takeSnapshot();
  if (res.skipped) {
    console.log(`Snapshot ${res.skipped} sudah ada — tidak ada yang ditulis.`);
  } else {
    console.log(`Snapshot tertulis: ${res.written.join(", ")}`);
  }
  console.log(JSON.stringify(res.snapshot, null, 2));
} catch (e) {
  console.error(`Equity snapshot failed: ${e.message}`);
  process.exit(1);
}
