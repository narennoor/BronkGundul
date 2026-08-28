// scripts/seed-equity-ledger.mjs — bootstrap sejarah ledger, ONE-SHOT (§13).
//
//   MERIDIAN_STATE_DIR=$HOME/BronkGundul node scripts/seed-equity-ledger.mjs --from=2026-07-21
//   MERIDIAN_STATE_DIR=$HOME/CopetGundul node scripts/seed-equity-ledger.mjs --from=2026-07-21
//
// WAJIB dijalankan dengan daemon wallet ybs DIPAUSE (pm2 stop <nama>) —
// telescoping saldo butuh wallet diam; skrip membaca balance sebelum+sesudah
// walk dan ABORT tanpa menulis apa pun bila bergeser. Satu walk penuh per
// wallet (fetchTxPage sudah ber-backoff 429); setelah seed sukses, rerun
// melewati walk sepenuhnya (nol Helius) dan hanya seal+verifikasi.
//
// Flags: --from=YYYY-MM-DD (wajib) · --dry-run (walk+validasi, tanpa tulis)
//        --max-pages=N (default 400)

import { loadEnv } from "../envcrypt.js";

loadEnv();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

try {
  const { seedLedger } = await import("../equity-seed.js");
  const res = await seedLedger({
    from: args.from,
    dryRun: !!args["dry-run"],
    maxPages: args["max-pages"] ? Number(args["max-pages"]) : undefined,
  });

  console.log(`\nWallet   : ${res.wallet}`);
  console.log(`Walk     : ${res.walked ? `${res.txs} tx` : "dilewati (sudah ter-seed)"}${res.dryRun ? " [DRY-RUN]" : ""}`);
  console.log(`Seeded   : ${res.written.length} entri${res.written.length ? ` (${res.written[0]} → ${res.written[res.written.length - 1]})` : ""}`);
  if (res.merged.length) console.log(`Merged   : ${res.merged.join(", ")} (genesis placeholder diisi window-nya)`);
  for (const v of res.validated) console.log(`Anchor   : ${v.id} turunan ${v.derived} ≡ terukur ${v.recorded} ✓`);
  if (res.today) console.log(`Hari ini : ${Array.isArray(res.today) ? res.today.join(", ") : `${res.today} (sudah ada)`}`);
  for (const s of res.sealed) console.log(`Seal     : ${s.kind} ${s.id} — net_rill ${s.net_rill_sol} SOL, integrity_ok=${s.integrity_ok}`);
  for (const s of res.skippedSeals) console.log(`Seal     : ${s}`);
  if (res.chain) {
    console.log(`Rantai   : ${Object.entries(res.chain.counts).map(([k, n]) => `${k}=${n}`).join(" · ")}`);
    if (res.chain.ok) console.log("Rantai   : assertion 7 hijau untuk seluruh sejarah ✓");
    else for (const p of res.chain.problems) console.log(`Rantai   : ✗ ${p}`);
  }
  if (res.chain && !res.chain.ok) process.exit(2);
} catch (e) {
  console.error(`Seed gagal: ${e.message}`);
  process.exit(1);
}
