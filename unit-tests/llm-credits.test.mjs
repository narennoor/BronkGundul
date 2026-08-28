// §14 — kas LLM prabayar (fetchLlmCredits, llmCreditsMemo, blok KAS LLM).
//
// Mandated by the design (28 Agu 2026, keputusan operator):
//   (a) kredit OpenRouter = aset USD level AKUN, tampil sebagai MEMO — tidak
//       pernah menyentuh total_ekuitas_sol/ROI/assertion mana pun,
//   (b) jalur laporan tetap nol-network: blok dirender dari pembacaan
//       `llm_credits` yang direkam snapshot + berkas deposit operator +
//       lifetime key grup dari ledger registry,
//   (c) boundary tanpa pembacaan → blok DISEMBUNYIKAN, bukan menebak,
//   (d) Σ deposit tercatat ≠ total akun → baris peringatan (berkas deposit
//       adalah catatan operator, API kebenarannya).

import { ledgerPath, REGISTRY_PATH, LLM_DEPOSITS_PATH } from "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

process.env.RPC_URL = "http://unit-test.invalid/rpc";
process.env.HELIUS_API_KEY = "unit-test-helius-key";
process.env.OPENROUTER_API_KEY = "unit-test-openrouter-key";

const { Keypair } = await import("@solana/web3.js");
const bs58 = (await import("bs58")).default;
const kp = () => {
  const k = Keypair.generate();
  return { address: k.publicKey.toString(), secret: bs58.encode(k.secretKey) };
};
const A = kp(); // wallet daemon (primary)
const B = kp();
process.env.WALLET_PRIVATE_KEY = A.secret;

// Jalur laporan tidak boleh menyentuh network.
globalThis.fetch = async (url) => {
  throw new Error(`zero-network violated: fetch(${String(url).slice(0, 80)})`);
};

const { llmCreditsMemo, formatFinancialReport } = await import("../financial-report.js");
const { fetchLlmCredits } = await import("../utils/chain-flows.js");
const { writeJsonAtomic } = await import("../utils/json-store.js");

// ── fixture: ledger A (dengan llm_credits) + ledger B + registry + deposit ──
const snap = (over) => ({
  id: "2026-08-28",
  boundary_ts: "2026-08-28T00:00:00Z",
  taken_at: "2026-08-28T00:05:00.000Z",
  source: "light",
  equity: { saldo_bebas_sol: 5, modal_posisi_sol: 0, principal_sol: 0, rent_sol: 0, total_sol: 5 },
  market_memo: { nilai_pasar_sol: 0, suspect: false },
  flows: { deposit_in_sol: 0, withdraw_out_sol: 0, gas_sol: 0, gas_txn: 0, transfers: [] },
  book: { closed: 0, wins: 0, fee_lp_sol: 0, net_revenue_sol: 0, liquidation_gap_sol: 0 },
  sol_price: 106.5,
  llm_usd_lifetime: null,
  llm_key_id: null,
  llm_credits: null,
  integrity: { delta_balance_sol: 0, flow_sum_sol: 0, drift_sol: 0, trusted: true, txs: 0 },
  window_sigs: [],
  ...over,
});
for (const [w, over] of [
  [A, { llm_usd_lifetime: 224.978015101, llm_key_id: "aaaa1111", llm_credits: { total_credits_usd: 258, total_usage_usd: 228.967101283 } }],
  [B, { llm_usd_lifetime: 1.337251068, llm_key_id: "bbbb2222" }],
]) {
  fs.mkdirSync(ledgerPath(w.address), { recursive: true });
  writeJsonAtomic(ledgerPath(w.address, "snapshots.json"), { version: 1, address: w.address, snapshots: [snap(over)] });
}
writeJsonAtomic(REGISTRY_PATH, {
  version: 1,
  group_name: "KasTest",
  primary: "A",
  wallets: [
    { id: "A", address: A.address, label: "A", transport: { kind: "fs" }, active_from: "2026-07-01", active_to: null },
    { id: "B", address: B.address, label: "B", transport: { kind: "fs" }, active_from: "2026-07-01", active_to: null },
  ],
});
const DEPOSITS = [
  { date: "2026-07-04", usd: 10 }, { date: "2026-07-05", usd: 38 }, { date: "2026-07-08", usd: 10 },
  { date: "2026-07-10", usd: 50 }, { date: "2026-07-14", usd: 50 }, { date: "2026-07-21", usd: 100 },
];
fs.mkdirSync(path.dirname(LLM_DEPOSITS_PATH), { recursive: true });
writeJsonAtomic(LLM_DEPOSITS_PATH, { version: 1, deposits: DEPOSITS });

// record minimal berbentuk §07 untuk formatter
const RECORD = {
  kind: "ytd", id: "2026-YTD",
  from: "2026-01-01T00:00:00Z", to: "2026-08-28T00:00:00Z", as_of: "2026-08-28T07:00:00Z",
  pnl: {
    fee_lp_sol: 21.3, impermanent_loss_sol: -25.4, net_revenue_sol: -4.1,
    exec_cost_sol: -4.6, exec_cost_measured_sol: -7.1, gas_fee_sol: -0.23, gross_rill_sol: -10.6,
    llm_cost_sol: -1.9, llm_cost_usd: -204.41, net_rill_sol: -12.55, closes: 2227, wins: 1340,
  },
  equity: {
    saldo_awal_sol: 0, deposit_sol: 28.46, withdrawal_sol: 0, modal_dasar_sol: 28.46,
    saldo_bebas_sol: 6.4, modal_posisi_sol: 11.3, modal_posisi_rent_sol: 0.06, total_ekuitas_sol: 17.8,
    laba_kumulatif_sol: -10.6, unrealized_pnl_sol: -0.03, unrealized_suspect: true,
  },
  roi: { dietz_pct: -47.95, twr_pct: -43.78 },
  integrity: { windows: 53, all_trusted: true, cum_drift_sol: 0, integrity_ok: true, assertions_failed: [] },
  sol_price_close: 106.5,
};

test("llmCreditsMemo: saldo, deposit, dan split grup dari berkas lokal", () => {
  const m = llmCreditsMemo(RECORD);
  assert.ok(m, "memo harus ada — boundary punya pembacaan");
  assert.equal(m.total_credits_usd, 258);
  assert.equal(m.total_usage_usd, 228.97);
  assert.equal(m.balance_usd, 29.03);
  assert.equal(m.deposits_usd, 258);
  assert.equal(m.deposit_count, 6);
  assert.equal(m.group_usage_usd, 226.32); // A 224.978 + B 1.337
});

test("formatter: blok KAS LLM tampil dengan angka yang benar", () => {
  const out = formatFinancialReport({ wallet: "KasTest", record: RECORD });
  assert.ok(out.includes("KAS LLM (USD · memo)"), out);
  assert.ok(out.includes("Deposit (6×)") && out.includes("+$258.00"));
  assert.ok(out.includes("Terpakai semua key") && out.includes("-$228.97"));
  assert.ok(out.includes("kunci grup") && out.includes("-$226.32"));
  assert.ok(out.includes("di luar grup") && out.includes("-$2.65"));
  assert.ok(out.includes("Sisa kredit") && out.includes("+$29.03"));
  assert.ok(!out.includes("⚠️ Σ deposit"), "Σ deposit cocok — tanpa peringatan");
});

test("boundary tanpa pembacaan → memo null, blok disembunyikan", () => {
  const rec = { ...RECORD, to: "2026-08-27T00:00:00Z", as_of: undefined };
  assert.equal(llmCreditsMemo(rec), null);
  const out = formatFinancialReport({ wallet: "KasTest", record: rec });
  assert.ok(!out.includes("KAS LLM"), "blok harus tersembunyi tanpa pembacaan");
});

test("Σ deposit tercatat ≠ total akun → baris peringatan", () => {
  writeJsonAtomic(LLM_DEPOSITS_PATH, { version: 1, deposits: DEPOSITS.slice(0, 5) }); // Σ 158
  const out = formatFinancialReport({ wallet: "KasTest", record: RECORD });
  assert.ok(out.includes("⚠️ Σ deposit tercatat") && out.includes("+$158.00"), out);
  writeJsonAtomic(LLM_DEPOSITS_PATH, { version: 1, deposits: DEPOSITS }); // pulihkan
});

test("fetchLlmCredits: bentuk sehat → objek; malformed → null; gagal → null", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ json: async () => ({ data: { total_credits: 258, total_usage: 228.9 } }) });
    assert.deepEqual(await fetchLlmCredits(), { total_credits_usd: 258, total_usage_usd: 228.9 });
    globalThis.fetch = async () => ({ json: async () => ({ data: { total_credits: "x" } }) });
    assert.equal(await fetchLlmCredits(), null);
    globalThis.fetch = async () => { throw new Error("down"); };
    assert.equal(await fetchLlmCredits(), null);
  } finally {
    globalThis.fetch = orig;
  }
});
