// scripts/financial-report.mjs — laporan keuangan one-shot ke stdout (§12).
//
//   node scripts/financial-report.mjs --kind=month --id=2026-08 --scope=group
//   node scripts/financial-report.mjs --kind=ytd --scope=wallet
//
// Read-only: membaca ledger + registry, TIDAK menyegel apa pun (seal adalah
// urusan cron/watchdog//report) dan tidak mengirim apa pun. Nol Helius, nol
// RPC. Dari worktree: MERIDIAN_STATE_DIR=$HOME/BronkGundul node scripts/…
// (scope=wallet butuh WALLET_PRIVATE_KEY dari .env untuk memilih ledger-nya;
// scope=group cukup registry).

import { loadEnv } from "../envcrypt.js";

loadEnv();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const kind = args.kind;
const scope = args.scope ?? "group";
if (!["week", "month", "year", "ytd"].includes(kind) || !["group", "wallet"].includes(scope)) {
  console.error("Pakai: --kind=week|month|year|ytd [--id=<YYYY-Www|YYYY-MM|YYYY>] --scope=group|wallet");
  process.exit(1);
}

try {
  const { formatFinancialReport, buildPeriodReport, buildYtdReport, lastClosedPeriodId } =
    await import("../financial-report.js");

  if (scope === "group") {
    const { consolidatePeriod } = await import("../consolidate.js");
    const id = args.id ?? (kind === "ytd" ? String(new Date().getUTCFullYear()) : lastClosedPeriodId(kind));
    const record = consolidatePeriod({ kind, id });
    console.log(formatFinancialReport({ wallet: record.group_name ?? "", record }));
  } else if (kind === "ytd") {
    const year = Number(args.id ?? new Date().getUTCFullYear());
    const record = buildYtdReport({ year });
    const { ledgerWalletAddress } = await import("../equity-snapshot.js");
    console.log(formatFinancialReport({ wallet: ledgerWalletAddress(), record }));
  } else {
    const id = args.id ?? lastClosedPeriodId(kind);
    console.log(formatFinancialReport(buildPeriodReport({ kind, id })));
  }
} catch (e) {
  console.error(`Laporan gagal: ${e.message}`);
  process.exit(1);
}
