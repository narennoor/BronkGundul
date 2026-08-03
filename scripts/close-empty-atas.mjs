// Tutup token account kosong milik wallet dan tarik balik rent-nya.
//
//   node scripts/close-empty-atas.mjs              → DRY RUN (default, tidak kirim tx)
//   node scripts/close-empty-atas.mjs --execute    → benar-benar kirim
//
// Tiap ATA menahan rent (~0.00204 SOL, lebih besar untuk Token-2022 ber-extension).
// Sisa ATA kosong dari posisi lama = SOL nganggur. Audit 3 Agu 2026: 71 akun
// kosong ≈ 0.145 SOL.
//
// Aman terhadap agen yang sedang jalan:
//   - hanya akun bersaldo NOL yang disentuh;
//   - mint milik posisi yang masih terbuka di-skip, supaya tidak ada tx close/swap
//     yang kehilangan ATA-nya di tengah jalan;
//   - kalau agen butuh mint itu lagi nanti, ATA-nya dibuat ulang otomatis.
// Tetap paling tenang dijalankan saat tidak ada posisi yang mau ditutup.
import fs from "fs";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { loadEnv } from "../envcrypt.js";
import { repoPath } from "../repo-root.js";

loadEnv();

const EXECUTE = process.argv.includes("--execute");
const BATCH = 12; // instruksi per tx — konservatif, jauh di bawah batas ukuran tx
const TOKEN_PROGRAMS = [
  ["SPL Token", new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")],
  ["Token-2022", new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")],
];

// SPL Token / Token-2022 instruksi #9 = CloseAccount.
// Akun: [account (w), destination (w), owner (signer)]
function closeAccountIx(account, destination, owner, programId) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const owner = wallet.publicKey;
const connection = new Connection(process.env.RPC_URL, "confirmed");

// Mint yang sedang dipakai posisi terbuka — jangan disentuh.
// trackPosition TIDAK menyimpan base_mint di state.json, jadi mint-nya
// diresolusi lewat pool-memory.json yang berkunci alamat pool. Kalau resolusi
// gagal, itu dilaporkan — guard yang diam-diam kosong lebih berbahaya daripada
// tidak ada guard sama sekali.
let busyMints = new Set();
let unresolvedOpen = 0;
try {
  const state = JSON.parse(fs.readFileSync(repoPath("state.json"), "utf8"));
  const poolMemory = JSON.parse(fs.readFileSync(repoPath("pool-memory.json"), "utf8"));
  for (const p of Object.values(state.positions || {})) {
    if (p.closed) continue;
    const mint = p.base_mint || poolMemory[p.pool]?.base_mint;
    if (mint) busyMints.add(mint);
    else unresolvedOpen++;
  }
} catch { /* tanpa file state, lanjut tanpa skip-list */ }
if (unresolvedOpen) {
  console.log(`⚠️ ${unresolvedOpen} posisi terbuka tidak bisa diresolusi base_mint-nya — ATA-nya TIDAK terlindungi skip-list.\n`);
}

const candidates = [];
let held = 0, skippedBusy = 0;
for (const [label, programId] of TOKEN_PROGRAMS) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { programId });
  let empty = 0;
  for (const { pubkey, account } of res.value) {
    const info = account.data.parsed.info;
    if (Number(info.tokenAmount.amount) !== 0) continue;
    empty++;
    if (busyMints.has(info.mint)) { skippedBusy++; continue; }
    candidates.push({ pubkey, programId, mint: info.mint, lamports: account.lamports });
    held += account.lamports;
  }
  console.log(`${label.padEnd(11)}: ${res.value.length} akun, ${empty} kosong`);
}

console.log(`\nkandidat ditutup : ${candidates.length}`);
if (skippedBusy) console.log(`di-skip (posisi terbuka): ${skippedBusy}`);
console.log(`rent bisa ditarik : ${(held / 1e9).toFixed(6)} SOL`);

if (!candidates.length) process.exit(0);
if (!EXECUTE) {
  console.log(`\nDRY RUN — tidak ada tx dikirim. Jalankan ulang dengan --execute kalau setuju.`);
  process.exit(0);
}

const before = await connection.getBalance(owner);
let closed = 0;
const failures = [];

async function send(group) {
  const tx = new Transaction();
  for (const c of group) tx.add(closeAccountIx(c.pubkey, owner, owner, c.programId));
  return sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
}

for (let i = 0; i < candidates.length; i += BATCH) {
  const group = candidates.slice(i, i + BATCH);
  try {
    const sig = await send(group);
    closed += group.length;
    console.log(`batch ${i / BATCH + 1}: ${group.length} ditutup — ${sig}`);
  } catch (e) {
    // Satu akun bermasalah menjatuhkan seluruh batch (mis. Token-2022 dengan
    // transfer-fee tertahan tidak bisa ditutup). Ulangi satu-satu supaya
    // sisanya tetap kebagian.
    console.log(`batch ${i / BATCH + 1} gagal (${e.message.slice(0, 80)}) — coba satu-satu`);
    for (const c of group) {
      try {
        await send([c]);
        closed++;
      } catch (e2) {
        failures.push({ mint: c.mint, reason: e2.message.slice(0, 100) });
      }
    }
  }
}

const after = await connection.getBalance(owner);
console.log(`\nditutup   : ${closed}/${candidates.length}`);
console.log(`gagal     : ${failures.length}`);
for (const f of failures) console.log(`  ${f.mint.slice(0, 12)} — ${f.reason}`);
console.log(`saldo     : ${(before / 1e9).toFixed(6)} → ${(after / 1e9).toFixed(6)} SOL  (netto ${((after - before) / 1e9).toFixed(6)}, sudah dikurangi gas)`);
