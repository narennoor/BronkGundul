import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Net native-SOL change for our wallet across a list of signatures.
 * `postBalance - preBalance` already nets out the fee the wallet paid, so the
 * result is real cash movement. A signature that is not yet queryable is
 * retried; anything still missing is reported rather than silently counted
 * as zero.
 *
 * @returns {Promise<{sol: number, found: number, missing: number}>}
 */
async function walletSolDelta(signatures, { attempts = 3, delayMs = 2000 } = {}) {
  const sigs = (signatures || []).filter(Boolean);
  if (!sigs.length) return { sol: 0, found: 0, missing: 0 };

  const connection = getConnection();
  const me = getWallet().publicKey.toString();
  let sol = 0, found = 0, missing = 0;

  for (const sig of sigs) {
    let tx = null;
    for (let attempt = 0; attempt < attempts && !tx; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, delayMs));
      try {
        tx = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
      } catch { /* transient RPC — retry */ }
    }
    // Static keys only, deliberately: `getAccountKeys()` throws on versioned
    // messages with address-table lookups, and our wallet is always a signer,
    // so it is always static. Static keys are the prefix of the balance arrays,
    // so the index is valid either way — including Jupiter RFQ fills where the
    // market maker, not us, is the fee payer.
    const msg = tx?.transaction?.message;
    const keys = msg?.staticAccountKeys || msg?.accountKeys || [];
    const idx = keys.findIndex((k) => k?.toString() === me);
    if (!tx || idx < 0) { missing++; continue; }
    sol += (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
    found++;
  }
  return { sol: Math.round(sol * 1e9) / 1e9, found, missing };
}

/**
 * Split a signature list into the ones that exist on-chain and the ones that
 * never landed. A submitted-but-expired signature is real input (we record every
 * attempt now, see state.recordCloseTxAttempt) but has zero cash effect, so it
 * must be dropped rather than counted as an unreadable tx — otherwise every
 * retried close would look permanently incomplete.
 *
 * getSignatureStatuses with searchTransactionHistory is authoritative here: no
 * status means the tx is not in the ledger, so it moved no lamports.
 */
async function partitionLandedSignatures(signatures) {
  const sigs = [...new Set((signatures || []).filter(Boolean))];
  if (!sigs.length) return { landed: [], neverLanded: [] };

  const connection = getConnection();
  const landed = [];
  const neverLanded = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const chunk = sigs.slice(i, i + 100);
    let statuses = null;
    try {
      statuses = (await connection.getSignatureStatuses(chunk, { searchTransactionHistory: true }))?.value;
    } catch (e) {
      log("wallet_warn", `Signature status lookup failed: ${e.message}`);
    }
    chunk.forEach((sig, idx) => {
      // On a lookup failure keep the signature — walletSolDelta will retry it and
      // report it missing, which is the conservative outcome.
      if (!statuses) return landed.push(sig);
      if (statuses[idx]) landed.push(sig);
      else neverLanded.push(sig);
    });
  }
  return { landed, neverLanded };
}

/**
 * Decide whether our on-chain measurement of the money coming back disagrees
 * with Meteora's own settled withdrawals by more than slippage can explain.
 *
 * Pure arithmetic, exported so it can be unit-tested without an RPC.
 * `inflowSol` = sol_in_close + sol_in_swap.
 *
 * The check is ASYMMETRIC on purpose, and the two directions mean different
 * things:
 *
 *  - **Negative** (we measured LESS than Meteora withdrew) is the era #9 failure
 *    mode: close signatures missing from our ledger. Anything past the tolerance
 *    is a fault.
 *  - **Positive** (we measured MORE) is normal and expected: closing a position
 *    refunds its account rent to the wallet, and Meteora's `withdrawals_sol`
 *    counts liquidity only. A 135-bin position holds ~0.109 SOL of rent — 4.3%
 *    of a 2.5 SOL deposit, i.e. four times the 1% tolerance. The first live
 *    close after the era #9 fix (KET-SOL, 10 Aug) flagged exactly that and was
 *    perfectly reconciled. Allow rent-sized surpluses; flag only what rent
 *    cannot explain.
 */
export const MAX_RENT_REFUND_SOL = 0.25;

export function evaluateCashMismatch({ inflowSol, withdrawalsSol, depositBasisSol, tolerancePct = 1 }) {
  const withdrawals = withdrawalsSol == null ? NaN : Number(withdrawalsSol);
  const basis = Math.abs(Number(depositBasisSol) || 0);
  if (!Number.isFinite(withdrawals) || basis <= 0) {
    return { mismatch_sol: null, over_tolerance: false, tolerance_sol: null, direction: null };
  }
  const mismatch = Math.round((Number(inflowSol || 0) - withdrawals) * 1e9) / 1e9;
  const toleranceSol = (basis * Number(tolerancePct || 0)) / 100;
  const shortfall = mismatch < -toleranceSol;
  const unexplainedSurplus = mismatch > toleranceSol + MAX_RENT_REFUND_SOL;
  return {
    mismatch_sol: mismatch,
    tolerance_sol: Math.round(toleranceSol * 1e9) / 1e9,
    over_tolerance: shortfall || unexplainedSurplus,
    direction: shortfall ? "shortfall" : unexplainedSurplus ? "surplus" : null,
  };
}

/**
 * Per-cycle cash reconciliation: what the wallet actually paid out at deploy
 * and actually got back at claim/close/swap, measured on-chain.
 *
 * Motivation (3 Aug 2026 analysis): closes that need no swap reconcile against
 * Meteora's bookkeeping to the lamport, while closes that do need one leak
 * ~1.9% of the swapped bag. Only ~0.7pp of that is referral + route; the rest
 * is the gap between Meteora's active-bin valuation of the withdrawn token and
 * the price Jupiter will actually pay for the whole bag seconds later. These
 * fields make that gap directly measurable instead of a residual.
 *
 * Read-only and off the execution path — call it after the swap has settled.
 */
export async function reconcileCycleCash({
  deploy_txs,
  claim_txs,
  close_txs,
  swap_tx,
  withdrawals_sol = null,
  deposits_sol = null,
}) {
  // Drop submitted-but-never-landed attempts before measuring.
  const [claimSet, closeSet] = await Promise.all([
    partitionLandedSignatures(claim_txs),
    partitionLandedSignatures(close_txs),
  ]);

  const [deploy, claim, close, swap] = await Promise.all([
    walletSolDelta(deploy_txs),
    walletSolDelta(claimSet.landed),
    walletSolDelta(closeSet.landed),
    walletSolDelta(swap_tx ? [swap_tx] : []),
  ]);
  const missing = deploy.missing + claim.missing + close.missing + swap.missing;

  // ── Cross-check against Meteora's own accounting ────────────────
  // walletSolDelta can only measure the signatures it is handed. If a close tx
  // never reached us (the pre-Aug-2026 failure mode: an exception discarded the
  // signatures of txs that HAD landed), the sum looks internally consistent and
  // `missing === 0` happily declares it complete — that is how four era #9 closes
  // booked -8.3 SOL of losses the wallet never took. Meteora's withdrawals_sol is
  // an independent measurement of the same money, so disagreeing with it by more
  // than a slippage-sized fraction of the deposit means signatures are missing,
  // not that the money is.
  const tolerancePct = Number(config.tx?.cashMismatchTolerancePct ?? 1);
  const {
    mismatch_sol: mismatchSol,
    over_tolerance: mismatchOverTolerance,
    direction: mismatchDirection,
  } = evaluateCashMismatch({
    inflowSol: close.sol + swap.sol,
    withdrawalsSol: withdrawals_sol,
    depositBasisSol: Math.abs(Number(deposits_sol) || 0) || Math.abs(deploy.sol),
    tolerancePct,
  });

  return {
    sol_out_deploy: deploy.sol,
    sol_in_claim: claim.sol,
    sol_in_close: close.sol,
    sol_in_swap: swap.sol,
    // Full round trip. Should equal pnl_sol minus gas when the books are right.
    sol_cycle_net: Math.round((deploy.sol + claim.sol + close.sol + swap.sol) * 1e9) / 1e9,
    cash_txs_found: deploy.found + claim.found + close.found + swap.found,
    cash_txs_missing: missing,
    cash_txs_never_landed: claimSet.neverLanded.length + closeSet.neverLanded.length,
    // Signed gap vs Meteora. Negative = we measured LESS coming back than
    // Meteora says was withdrawn (missing close signatures). A small positive
    // gap is the position-account rent refund and is expected — see
    // evaluateCashMismatch.
    cash_mismatch_sol: mismatchSol,
    cash_mismatch_direction: mismatchDirection,
    cash_mismatch_tolerance_pct: tolerancePct,
    // Any unresolved signature — or a cross-check that fails — makes the totals
    // incomplete. Never let a partial sum pass as a real shortfall.
    cash_complete: missing === 0 && deploy.found > 0 && close.found > 0 && !mismatchOverTolerance,
    cash_mismatch_over_tolerance: mismatchOverTolerance,
  };
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const quotedAtMs = Date.now();
    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;
    const orderLatencyMs = Date.now() - quotedAtMs;
    if (order.priceImpactPct != null || order.outAmount != null) {
      log("swap", `Quote: out=${order.outAmount ?? "?"} impact=${order.priceImpactPct ?? "?"}% slippage=${order.slippageBps ?? "?"}bps (order ${orderLatencyMs}ms)`);
    }

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    const executedAtMs = Date.now();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
      // Exit-slippage instrumentation: quote-side fields Jupiter already returns
      // but were previously discarded. Raw units (lamports/smallest unit).
      quote_in_amount: order.inAmount ?? null,
      quote_out_amount: order.outAmount ?? null,
      quote_price_impact_pct: order.priceImpactPct != null ? Number(order.priceImpactPct) : null,
      quote_slippage_bps: order.slippageBps ?? null,
      quote_in_usd: order.inUsdValue ?? null,
      quote_out_usd: order.outUsdValue ?? null,
      quoted_at: new Date(quotedAtMs).toISOString(),
      executed_at: new Date(executedAtMs).toISOString(),
      order_latency_ms: orderLatencyMs,
      execute_latency_ms: executedAtMs - quotedAtMs - orderLatencyMs,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
