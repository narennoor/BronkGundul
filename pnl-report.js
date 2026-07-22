// pnl-report.js — comprehensive PnL report: app bookkeeping (fee LP + IL from
// lessons.json) reconciled against real on-chain SOL flows (Helius), plus gas
// and LLM cost. The gap between bookkeeping and on-chain cash is reported as
// execution cost (swap slippage, referral, quote-vs-execution drift).
//
// Used by scripts/pnl-report.mjs (CLI) and the Telegram /pnl command.

import fs from "fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { repoPath } from "./repo-root.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const OUTFLOW_TX_TYPES = new Set([
  "INITIALIZE_POSITION",
  "INITIALIZE_BIN_ARRAY",
  "ADD_LIQUIDITY",
  "UNKNOWN",
]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(repoPath(file), "utf8"));
  } catch {
    return fallback;
  }
}

function walletChange(tx, wallet) {
  const entry = (tx.accountData || []).find((a) => a.account === wallet);
  return entry ? entry.nativeBalanceChange / 1e9 : 0;
}

async function fetchAllTxs(wallet, heliusKey) {
  const txs = [];
  let before;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
    url.searchParams.set("api-key", heliusKey);
    url.searchParams.set("limit", "100");
    if (before) url.searchParams.set("before", before);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Helius ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const batch = await res.json();
    if (!batch.length) break;
    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    await new Promise((r) => setTimeout(r, 250));
  }
  return txs;
}

async function fetchBalance(wallet) {
  const res = await fetch(process.env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC getBalance: ${json.error.message}`);
  return json.result.value / 1e9;
}

async function fetchSolPrice() {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const price = (await res.json())?.[SOL_MINT]?.usdPrice;
  if (!price) throw new Error("Gagal ambil harga SOL dari Jupiter Price API");
  return price;
}

async function fetchLlmUsage() {
  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
    });
    return (await res.json())?.data?.usage ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute the full report. Throws on missing env (HELIUS_API_KEY, RPC_URL,
 * WALLET_PRIVATE_KEY) or unreachable price API; LLM usage failure is non-fatal.
 */
export async function computePnlReport() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  if (!process.env.HELIUS_API_KEY) throw new Error("HELIUS_API_KEY not set");
  if (!process.env.RPC_URL) throw new Error("RPC_URL not set");

  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();

  // ── app bookkeeping ────────────────────────────────────────────
  const perf = readJson("lessons.json", {}).performance || [];
  let pnlUsd = 0, feesUsd = 0, wins = 0, losses = 0, heldMin = 0;
  for (const p of perf) {
    pnlUsd += p.pnl_usd || 0;
    feesUsd += p.fees_earned_usd || 0;
    (p.pnl_usd || 0) >= 0 ? wins++ : losses++;
    heldMin += p.minutes_held || 0;
  }
  const ilUsd = pnlUsd - feesUsd;

  const statePositions = Object.values(readJson("state.json", {}).positions || {});
  const openPositions = statePositions.filter((p) => !p.closed);

  // ── on-chain flows (retry once if a tx lands mid-computation) ──
  let txs, balance, flowSum, consistent = false;
  for (let attempt = 0; attempt < 2 && !consistent; attempt++) {
    txs = await fetchAllTxs(wallet, process.env.HELIUS_API_KEY);
    balance = await fetchBalance(wallet);
    flowSum = txs.reduce((s, t) => s + walletChange(t, wallet), 0);
    consistent = Math.abs(flowSum - balance) < 1e-6;
  }

  let gasSol = 0, gasTxn = 0, depositIn = 0, withdrawOut = 0;
  for (const t of txs) {
    if (t.feePayer === wallet) { gasSol += t.fee / 1e9; gasTxn++; }
    for (const nt of t.nativeTransfers || []) {
      if (nt.amount <= 5e6) continue;
      if (nt.toUserAccount === wallet && t.feePayer !== wallet) depositIn += nt.amount / 1e9;
      if (nt.fromUserAccount === wallet && t.feePayer === wallet && t.type === "TRANSFER") withdrawOut += nt.amount / 1e9;
    }
  }
  const depositNet = depositIn - withdrawOut;

  // Exact SOL locked in open positions: their deploy txs (principal + rent + gas),
  // matched by timestamp window. Deploys are minutes apart (screening interval),
  // so a 150s window cannot capture another position's deploy txs.
  const openDetail = openPositions.map((p) => {
    const t0 = Date.parse(p.deployed_at) / 1000;
    const mine = txs.filter(
      (t) => t.timestamp >= t0 - 20 && t.timestamp <= t0 + 150 &&
        OUTFLOW_TX_TYPES.has(t.type) && walletChange(t, wallet) < 0,
    );
    const outflow = -mine.reduce((s, t) => s + walletChange(t, wallet), 0);
    const gasIn = mine.reduce((s, t) => s + (t.feePayer === wallet ? t.fee / 1e9 : 0), 0);
    return { pool: p.pool_name, principal: p.amount_sol || 0, outflow, gasIn, deployed_at: p.deployed_at };
  });
  const lockedOut = openDetail.reduce((s, o) => s + o.outflow, 0);
  const lockedGas = openDetail.reduce((s, o) => s + o.gasIn, 0);
  const lockedPrincipal = openDetail.reduce((s, o) => s + o.principal, 0);
  const lockedRent = lockedOut - lockedPrincipal - lockedGas;

  const solPrice = await fetchSolPrice();
  const llmUsd = await fetchLlmUsage();

  // ── the bridge: bookkeeping → real cash ────────────────────────
  const netRevBookUsd = pnlUsd;
  const netRevBookSol = netRevBookUsd / solPrice;
  // realized cash of all CLOSED cycles = balance + locked − deposits
  const grossRealSol = balance + lockedOut - depositNet;          // after gas
  const netRevRealSol = grossRealSol + gasSol - lockedGas;        // before gas
  const execCostSol = netRevBookSol - netRevRealSol;
  const llmSol = llmUsd != null ? llmUsd / solPrice : 0;
  const netRealSol = grossRealSol - llmSol;

  return {
    generated_at: new Date().toISOString(),
    wallet,
    sol_price: solPrice,
    consistent,
    perf: {
      closed: perf.length, wins, losses,
      win_rate_pct: perf.length ? Math.round((wins / perf.length) * 100) : 0,
      avg_held_min: perf.length ? Math.round(heldMin / perf.length) : 0,
      fees_usd: feesUsd, il_usd: ilUsd, net_rev_usd: netRevBookUsd,
    },
    bridge: {
      net_rev_book_sol: netRevBookSol,
      exec_cost_sol: execCostSol,
      net_rev_real_sol: netRevRealSol,
      gas_sol: gasSol, gas_txn: gasTxn,
      gross_real_sol: grossRealSol,
      llm_usd: llmUsd, llm_sol: llmSol,
      net_real_sol: netRealSol,
      net_book_usd: netRevBookUsd - gasSol * solPrice - (llmUsd || 0),
    },
    equity: {
      deposit_in: depositIn, withdraw_out: withdrawOut, deposit_net: depositNet,
      balance, locked_principal: lockedPrincipal, locked_rent: lockedRent,
      total: balance + lockedOut,
      drift_sol: balance + lockedOut - depositNet,
    },
    open: openDetail,
    tx_count: txs.length,
  };
}

const fmtUsd = (v, sign = true) => `${v < 0 ? "-" : sign ? "+" : ""}$${Math.abs(v).toFixed(2)}`;
const fmtSol = (v, sign = true) => `${v < 0 ? "-" : sign ? "+" : ""}${Math.abs(v).toFixed(4)}`;

/**
 * Render the report as aligned plain text (CLI) or Telegram HTML (<pre> block).
 */
export function formatPnlReport(r, { html = false } = {}) {
  const sp = r.sol_price;
  const row = (label, usd, sol) =>
    `${label.padEnd(18)}${fmtUsd(usd).padStart(9)}${fmtSol(sol).padStart(10)}`;
  const b = r.bridge;
  const e = r.equity;

  const lines = [
    `${r.perf.closed} closed | ${r.perf.wins}W/${r.perf.losses}L (${r.perf.win_rate_pct}%) | avg hold ${r.perf.avg_held_min}m | ${r.open.length} open`,
    "",
    "PEMBUKUAN (posisi closed)         USD       SOL",
    row("Fee LP", r.perf.fees_usd, r.perf.fees_usd / sp),
    row("Impermanent loss", r.perf.il_usd, r.perf.il_usd / sp),
    row("Net Revenue", r.perf.net_rev_usd, b.net_rev_book_sol),
    "",
    "KAS RIIL ON-CHAIN",
    row("Biaya eksekusi", -b.exec_cost_sol * sp, -b.exec_cost_sol),
    row("Net Revenue riil", b.net_rev_real_sol * sp, b.net_rev_real_sol),
    row(`Gas (${b.gas_txn} tx)`, -b.gas_sol * sp, -b.gas_sol),
    row("Gross riil", b.gross_real_sol * sp, b.gross_real_sol),
    b.llm_usd != null
      ? row("LLM (OpenRouter)", -b.llm_usd, -b.llm_sol)
      : "LLM (OpenRouter)      n/a",
    row("NET RIIL", b.net_real_sol * sp, b.net_real_sol),
    "",
    `Memo NET versi pembukuan: ${fmtUsd(b.net_book_usd)}`,
    "",
    "EKUITAS (SOL)",
    `Deposit netto     ${fmtSol(e.deposit_net, false).padStart(10)}`,
    `Saldo bebas       ${fmtSol(e.balance, false).padStart(10)}`,
    `Modal ${String(r.open.length).padStart(2)} posisi   ${fmtSol(e.locked_principal, false).padStart(10)}  (+rent ${e.locked_rent.toFixed(4)})`,
    `Ekuitas           ${fmtSol(e.total, false).padStart(10)}  (${fmtUsd(e.total * sp, false)})`,
    `Untung/rugi       ${fmtSol(b.net_real_sol).padStart(10)}  (${fmtUsd(b.net_real_sol * sp)})`,
    `  = ekuitas - deposit - biaya LLM`,
    `ROI               ${(e.deposit_net > 0
      ? `${b.net_real_sol >= 0 ? "+" : ""}${((b.net_real_sol / e.deposit_net) * 100).toFixed(2)}%`
      : "n/a").padStart(10)}`,
  ];
  if (r.open.length) {
    lines.push("", `Open: ${r.open.map((o) => `${o.pool} ${o.principal}`).join(" | ")}`);
  }
  if (b.exec_cost_sol < -0.005) {
    lines.push("", "⚠️ Kas riil LEBIH BAIK dari pembukuan — biasanya ada entri close dengan quote pool yang salah (mis. flash-dump saat close). On-chain yang benar; cek entri performance terakhir.");
  }
  if (!r.consistent) {
    lines.push("", "⚠️ Saldo & aliran tx belum sinkron (ada tx baru saat menghitung) — angka on-chain bisa meleset tipis; coba ulang.");
  }

  const stamp = r.generated_at.slice(0, 16).replace("T", " ");
  const title = `📒 PnL Meridian — ${stamp} UTC | SOL $${sp.toFixed(2)}`;
  if (html) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<b>${esc(title)}</b>\n<pre>${esc(lines.join("\n"))}</pre>`;
  }
  return `${title}\n${lines.join("\n")}`;
}
