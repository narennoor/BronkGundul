// Rotasi funnel-stats per era: arsipkan counter berjalan ke
// funnel-stats-history.json lalu mulai bersih dengan stempel era.
//
//   node scripts/rotate-funnel-stats.mjs            → tampilkan status saja
//   node scripts/rotate-funnel-stats.mjs era8       → rotasi dgn label era8
//
// Jalankan SETIAP kali era baru mulai (idealnya tepat setelah restart era).
// Aman terhadap daemon yang hidup: recordFunnelCycle menulis-balik seluruh
// objek jadi field era selamat; satu-satunya race adalah load daemon yang
// terjadi persis di tengah rotasi menimpa reset — makanya ada verifikasi
// (tunggu > interval opportunity-poll, baca ulang, ulangi maksimal 2x).
import { setTimeout as sleep } from "timers/promises";
import { getFunnelStats, rotateFunnelStats, summarizeFunnel } from "../funnel-stats.js";

const label = process.argv[2];

if (!label) {
  const db = getFunnelStats();
  console.log(`era saat ini : ${db.era ?? "(belum distempel)"}`);
  console.log(`since        : ${db.since}`);
  console.log(summarizeFunnel("client"));
  console.log(summarizeFunnel("shadow"));
  console.log("\nUntuk rotasi: node scripts/rotate-funnel-stats.mjs <label-era>");
  process.exit(0);
}

const before = getFunnelStats();
console.log(`arsip: era=${before.era ?? "(tanpa label)"} since=${before.since} client.cycles=${before.client.cycles} shadow.cycles=${before.shadow.cycles}`);

for (let attempt = 1; attempt <= 3; attempt++) {
  rotateFunnelStats(label);
  // Poll opportunity (45s) adalah penulis paling rapat — tunggu melewatinya
  // lalu pastikan reset kita tidak tertimpa load-modify-save daemon yang
  // sedang berlangsung saat rotasi.
  await sleep(60_000);
  const now = getFunnelStats();
  if (now.era === label && now.client.cycles < before.client.cycles) {
    console.log(`ROTASI OK (percobaan ${attempt}): era=${now.era} since=${now.since} client.cycles=${now.client.cycles}`);
    console.log("Catatan: entri arsip duplikat dari percobaan gagal (kalau ada) dibiarkan di history — counter arsip pertama yang paling lengkap.");
    process.exit(0);
  }
  console.log(`percobaan ${attempt}: reset tertimpa daemon (era=${now.era} cycles=${now.client.cycles}) — ulangi`);
}
console.log("GAGAL setelah 3 percobaan — jalankan ulang saat daemon senggang (di luar cycle).");
process.exit(1);
