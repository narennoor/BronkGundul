import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  recordCloseTxAttempt,
  getCloseTxAttempts,
  getTrailingTrace,
  getTrackedPosition,
  getTrackedPositions,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { getWalletBalances, normalizeMint } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "./agent-meridian.js";
import { getAndClearStagedSignals, peekStagedSignals } from "../signal-tracker.js";
import { computePositions, fetchDlmmPnlForPool, isDepositPartiallyIndexed } from "./pnl.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

// ─── Centralized transaction submission ────────────────────────
// Every on-chain write in this file goes through sendTx(). web3.js's
// sendAndConfirmTransaction is deliberately NOT used: it sends with the RPC's
// internal retry (which stops the moment the node drops the tx from its queue),
// carries no compute budget, and — the expensive part — throws away the
// signature when the confirmation times out. Era #9's 135-bin txs are heavy
// enough that "block height exceeded" became routine (19 occurrences 5-10 Aug,
// zero in era #8), and each lost signature took a chunk of the cash accounting
// with it (see reconcileCycleCash / close_tx_attempts).
//
// sendTx guarantees:
//   - ComputeBudget price + limit instructions are prepended (unless the tx
//     already carries its own),
//   - raw send with maxRetries: 0 and our own ~2s rebroadcast loop that runs
//     until the blockhash dies,
//   - blockhash-scoped confirmTransaction, with a getSignatureStatus check
//     before declaring failure (an "expired" tx has often actually landed),
//   - the signature is ALWAYS available — returned on success, attached as
//     `error.signature` on every failure path.

const PRIORITY_FEE_CACHE_MS = 15_000;
let _priorityFeeCache = { at: 0, key: null, value: null };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPriorityFee(value) {
  const floor = Number(config.tx.priorityFeeFloor) || 0;
  const cap = Number(config.tx.priorityFeeCap) || floor;
  const n = Number(value);
  if (!Number.isFinite(n)) return floor;
  return Math.round(Math.min(Math.max(n, floor), Math.max(floor, cap)));
}

function toPublicKeys(accounts) {
  const keys = [];
  for (const account of accounts || []) {
    try {
      keys.push(account instanceof PublicKey ? account : new PublicKey(String(account)));
    } catch { /* skip unparsable */ }
  }
  return keys;
}

/**
 * Priority fee in micro-lamports per compute unit.
 * Dynamic mode asks the RPC for recent fees on the accounts this tx writes to
 * (the pool) and takes the ~75th percentile — high enough to beat the crowd
 * competing for the same pool, low enough not to overpay a quiet market.
 * Any RPC failure falls back to the configured floor, never to zero.
 */
export async function resolvePriorityFee(connection, writableAccounts = []) {
  const configured = config.tx.priorityFeeMicroLamports;
  if (configured != null) return { micro: clampPriorityFee(configured), source: "static" };

  const keys = toPublicKeys(writableAccounts);
  const cacheKey = keys.map((k) => k.toString()).sort().join(",");
  if (_priorityFeeCache.key === cacheKey && Date.now() - _priorityFeeCache.at < PRIORITY_FEE_CACHE_MS) {
    return { micro: _priorityFeeCache.value, source: "cached" };
  }

  try {
    const samples = await connection.getRecentPrioritizationFees(
      keys.length ? { lockedWritableAccounts: keys } : {},
    );
    const values = (samples || [])
      .map((s) => Number(s?.prioritizationFee))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!values.length) throw new Error("no prioritization-fee samples");
    const p75 = values[Math.min(values.length - 1, Math.floor(values.length * 0.75))];
    const micro = clampPriorityFee(p75);
    _priorityFeeCache = { at: Date.now(), key: cacheKey, value: micro };
    return { micro, source: `p75/${values.length}` };
  } catch (error) {
    return { micro: clampPriorityFee(config.tx.priorityFeeFloor), source: `floor (${error.message})` };
  }
}

// Which compute-budget instructions a tx ALREADY carries, by opcode
// (2 = SetComputeUnitLimit, 3 = SetComputeUnitPrice).
//
// This has to be per-kind, not "does it have any". The Meteora SDK ships a
// well-fitted SetComputeUnitLimit of its own (162 299 on a claim that burns
// 112k CU) but never a price, so a blanket "already has a budget → leave it
// alone" check silently skipped the priority fee on every SDK tx — which is the
// entire point of this helper. Caught on the first live close after deploy:
// `fee 0 µLamports/CU (preset)`, 5000 lamports paid, i.e. base fee only.
function computeBudgetKinds(tx) {
  const kinds = new Set();
  for (const ix of tx?.instructions || []) {
    if (ix?.programId?.toString?.() !== ComputeBudgetProgram.programId.toString()) continue;
    const op = ix.data?.[0];
    if (op === 2) kinds.add("limit");
    else if (op === 3) kinds.add("price");
  }
  return kinds;
}

function isAlreadyProcessed(error) {
  return /already been processed|AlreadyProcessed/i.test(String(error?.message || ""));
}

async function extractSimulationLogs(error, connection) {
  if (Array.isArray(error?.logs) && error.logs.length) return error.logs;
  try {
    const logs = await error?.getLogs?.(connection);
    return Array.isArray(logs) ? logs : null;
  } catch {
    return null;
  }
}

/**
 * Send + confirm one legacy Transaction. Returns the signature.
 * Throws on failure with `error.signature` set (and `error.simulationLogs`
 * when preflight rejected it) so callers never lose a submitted signature.
 *
 * @param {import("@solana/web3.js").Transaction} tx
 * @param {Array} signers - signers[0] pays the fee
 * @param {object} opts
 * @param {string} opts.label - log label, e.g. "close_remove"
 * @param {number} [opts.cuLimit] - compute-unit limit (defaults to config.tx.computeUnitLimit)
 * @param {number} [opts.priorityMicroLamports] - explicit price, skips the dynamic lookup
 * @param {Array} [opts.writableAccounts] - accounts to price the dynamic fee against
 * @param {object} [opts.connection] - injectable for tests
 */
export async function sendTx(tx, signers, opts = {}) {
  const {
    label = "tx",
    cuLimit = null,
    priorityMicroLamports = null,
    writableAccounts = [],
    connection = null,
    commitment = "confirmed",
  } = opts;
  const conn = connection || getConnection();
  const timeoutMs = Number(opts.confirmTimeoutMs ?? config.tx.confirmTimeoutMs);
  const intervalMs = Math.max(50, Number(opts.rebroadcastIntervalMs ?? config.tx.rebroadcastIntervalMs));
  const units = Number(cuLimit ?? config.tx.computeUnitLimit);

  const existingBudget = computeBudgetKinds(tx);
  const budgetIxs = [];
  // The SDK's own limit is measured against its own instruction set — trust it
  // over our per-call-site default whenever it is there.
  let appliedLimit = existingBudget.has("limit") ? "sdk" : null;
  if (!existingBudget.has("limit") && Number.isFinite(units) && units > 0) {
    appliedLimit = Math.round(units);
    budgetIxs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: appliedLimit }));
  }
  let fee = { micro: 0, source: "sdk" };
  if (!existingBudget.has("price")) {
    fee = priorityMicroLamports != null
      ? { micro: clampPriorityFee(priorityMicroLamports), source: "explicit" }
      : await resolvePriorityFee(conn, writableAccounts);
    if (fee.micro > 0) {
      budgetIxs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee.micro }));
    }
  }
  if (budgetIxs.length) tx.instructions.unshift(...budgetIxs);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const signature = bs58.encode(tx.signature);
  const raw = tx.serialize();

  const startedAt = Date.now();
  let rebroadcasts = 0;

  const broadcast = async (skipPreflight) => {
    try {
      await conn.sendRawTransaction(raw, { skipPreflight, maxRetries: 0, preflightCommitment: commitment });
      return null;
    } catch (error) {
      return error;
    }
  };

  // First send keeps preflight ON so a genuine program error surfaces here, with
  // its simulation logs, instead of as an opaque "Simulation failed" (5 such
  // DEPLOY_ERRORs in era #9 had no readable cause).
  const preflightError = await broadcast(false);
  if (preflightError && !isAlreadyProcessed(preflightError)) {
    const logs = await extractSimulationLogs(preflightError, conn);
    const error = new Error(
      `${label} simulation failed: ${preflightError.message}` +
      (logs?.length ? ` | logs: ${logs.slice(-8).join(" | ")}` : ""),
    );
    error.signature = signature;
    error.simulationLogs = logs;
    throw error;
  }

  let settled = null;
  const confirmPromise = conn
    .confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment)
    .then((res) => ({ ok: true, value: res?.value ?? null }))
    .catch((error) => ({ ok: false, error }));
  confirmPromise.then((res) => { settled = res; });

  while (!settled && Date.now() - startedAt < timeoutMs) {
    await sleep(intervalMs);
    if (settled) break;
    // Poll the ledger alongside confirmTransaction. That call rides a WebSocket
    // subscription; if the endpoint has no ws (or drops it) it never resolves,
    // and without this poll every single tx would burn the full confirm timeout.
    const polled = await conn
      .getSignatureStatus(signature, { searchTransactionHistory: false })
      .catch(() => null);
    if (polled?.value) {
      settled = { ok: true, value: { err: polled.value.err ?? null } };
      break;
    }
    // Blockhash dead → rebroadcasting is pointless; fall through to the
    // signature-status check, which decides whether it landed in time.
    let height = null;
    try { height = await conn.getBlockHeight(commitment); } catch { /* transient */ }
    if (height != null && height > lastValidBlockHeight) break;
    await broadcast(true);
    rebroadcasts++;
  }

  const result = settled || (await Promise.race([confirmPromise, sleep(1_000).then(() => null)]));
  const elapsedMs = Date.now() - startedAt;

  if (result?.ok && !result.value?.err) {
    log(
      "tx",
      `${label} confirmed in ${elapsedMs}ms — fee ${fee.micro} µLamports/CU (${fee.source}), cu_limit ${appliedLimit}, ${rebroadcasts} rebroadcast(s): ${signature}`,
    );
    return signature;
  }
  if (result?.ok && result.value?.err) {
    const error = new Error(`${label} failed on-chain: ${JSON.stringify(result.value.err)}`);
    error.signature = signature;
    throw error;
  }

  // Confirmation timed out or the subscription failed. "Expired" is frequently a
  // lie — check the ledger once before writing the tx off.
  const status = await conn
    .getSignatureStatus(signature, { searchTransactionHistory: true })
    .catch(() => null);
  const value = status?.value ?? null;
  const landed = value && !value.err &&
    (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized" || (value.confirmations ?? 0) > 0);
  if (landed) {
    log(
      "tx",
      `${label} landed despite confirm timeout (${elapsedMs}ms, ${rebroadcasts} rebroadcast(s), fee ${fee.micro} µLamports/CU): ${signature}`,
    );
    return signature;
  }

  const error = new Error(
    value?.err
      ? `${label} failed on-chain: ${JSON.stringify(value.err)}`
      : `${label} expired: no confirmation in ${elapsedMs}ms after ${rebroadcasts} rebroadcast(s) (fee ${fee.micro} µLamports/CU, ${fee.source})`,
  );
  error.signature = signature;
  throw error;
}

// The pool account is the contended writable account for every DLMM tx, so it is
// what the dynamic priority fee should be priced against.
function poolWritableAccounts(pool) {
  const key = pool?.pubkey?.toString?.()
    || pool?.lbPair?.publicKey?.toString?.()
    || pool?.lbPair?.pubkey?.toString?.()
    || null;
  return key ? [key] : [];
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const indexes = ix.accountKeyIndexes || ix.accounts || [];
      const accounts = indexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

// unref'd: these are pure cache evictions, nothing depends on them running, and
// an un-unref'd module-level interval keeps any process that merely imports this
// file alive forever (which is what made the module untestable).
setInterval(() => poolCache.clear(), 5 * 60 * 1000).unref?.();
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000).unref?.();

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Strategy Picker ───────────────────────────────────────────
// Deterministic per-deploy strategy selection ("JS decides, LLM executes").
// Only active when config.strategy.strategyMode === "auto": a range narrower than
// spotBinsThreshold (the bins_below formula output on low-volatility pools)
// deploys as spot, everything else keeps the configured default strategy.
// An explicit LLM/user strategy always wins over the picker.
export function pickDeployStrategy(binsBelow) {
  const fallback = { strategy: config.strategy.strategy, source: "config" };
  if (String(config.strategy.strategyMode || "fixed").toLowerCase() !== "auto") return fallback;
  const threshold = Number(config.strategy.spotBinsThreshold);
  const bins = Number(binsBelow);
  if (!Number.isFinite(threshold) || !Number.isFinite(bins)) return fallback;
  return {
    strategy: bins < threshold ? "spot" : config.strategy.strategy,
    source: "auto_picker",
  };
}

// ─── Wide-path partial-deploy helpers ──────────────────────────

// Best-effort close of a just-created position that never received liquidity,
// so the (refundable) position rent comes back instead of stranding an
// invisible empty position — empty positions never show in the portfolio API.
async function closeEmptyWidePosition(pool, positionPubkey, wallet) {
  try {
    const tx = await pool.closePositionIfEmpty({
      owner: wallet.publicKey,
      position: { publicKey: positionPubkey },
    });
    const txs = Array.isArray(tx) ? tx : [tx];
    for (const t of txs) {
      // Measured 19k CU for the position-account path; 200k is generous headroom.
      await sendTx(t, [wallet], { label: "close_empty_position", cuLimit: 200_000, writableAccounts: poolWritableAccounts(pool) });
    }
    log("deploy", `Closed empty wide position ${positionPubkey.toString().slice(0, 8)} — rent reclaimed`);
  } catch (error) {
    log("deploy_error", `Could not close empty position ${positionPubkey.toString().slice(0, 8)}: ${error.message}. Close it manually to reclaim the rent.`);
  }
}

// Read the actual on-chain balances/bin range of a partially filled position
// straight from the position account (no indexer lag). Right after a deploy
// there are no fees yet, so totalYAmount ≈ the SOL that actually landed.
async function readDeployedPositionState(pool, positionPubkey) {
  try {
    const p = await pool.getPosition(positionPubkey);
    const d = p?.positionData || {};
    const y = d.totalYAmount != null ? Number(d.totalYAmount.toString()) / 1e9 : null;
    return {
      amount_sol: y != null && Number.isFinite(y) ? roundNum(y, 6) : null,
      lower_bin: d.lowerBinId ?? null,
      upper_bin: d.upperBinId ?? null,
    };
  } catch (error) {
    log("deploy_warn", `Could not read partial position state for ${positionPubkey.toString().slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  // entry market conditions (injected by executor safety checks)
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
  entry_fee_tvl_fast,
  entry_fee_tvl_slow,
  fee_gate_timeframe,
}) {
  pool_address = normalizeMint(pool_address);
  // Strategy is resolved after the bin range is final (see pickDeployStrategy below)
  // so the auto picker can read the actual bins_below of this deploy.
  let activeStrategy = strategy || null;
  let strategySource = strategy ? "explicit" : "config";
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }
  // Refresh the cached lbPair snapshot before planning the range. Pool objects
  // live in a 5-minute cache and getActiveBin() does NOT update pool.lbPair,
  // while the SDK's wide-range add-liquidity (rebalanceLiquidity) anchors its
  // deposit bins to pool.lbPair.activeId as active-bin-relative deltas. A stale
  // anchor shifts the executed bins away from the planned (and pre-checked)
  // range — 5 Aug 2026 SISYPUSS: a 4-bin shift pushed chunk 2 into a bin array
  // absent from the tx account list → InvalidBinArray 6027, partial deploy.
  await pool.refetchStates();
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  if (!activeStrategy) {
    const picked = pickDeployStrategy(activeBinsBelow);
    activeStrategy = picked.strategy;
    strategySource = picked.source;
    if (picked.source === "auto_picker") {
      log("deploy", `Strategy picker: bins_below ${activeBinsBelow} vs threshold ${config.strategy.spotBinsThreshold} → ${activeStrategy}`);
    }
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  let finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: this agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }

  // Smart-wallet size bonus — a tracked smart wallet present at screening time boosts
  // the deploy amount by smartWalletSizeBonusPct (era #3: smart_wallets_present closes
  // mean $1.43 vs $0.10 without, n=62/165). Clamped to maxDeployAmount and the wallet's
  // spendable balance so the executor's pre-flight balance check stays valid.
  let swSizeBoosted = false;
  const swBonusPct = Number(config.management.smartWalletSizeBonusPct ?? 0);
  if (swBonusPct > 0 && isSingleSidedSol && finalAmountY > 0) {
    try {
      const staged = peekStagedSignals(pool_address, baseMint);
      if (staged?.smart_wallets_present === true) {
        const walletSol = (await getWalletBalances()).sol;
        const gasReserve = Number(config.management.gasReserve ?? 0.2);
        const spendable = Math.max(0, walletSol - gasReserve);
        const boosted = Math.min(
          finalAmountY * (1 + swBonusPct / 100),
          Number(config.risk.maxDeployAmount ?? finalAmountY),
          spendable,
        );
        if (boosted > finalAmountY) {
          log("deploy", `Smart-wallet size bonus: ${finalAmountY} -> ${boosted.toFixed(2)} SOL (+${swBonusPct}%)`);
          finalAmountY = parseFloat(boosted.toFixed(2));
          swSizeBoosted = true;
        }
      }
    } catch (error) {
      log("deploy", `Smart-wallet size bonus skipped: ${error.message}`);
    }
  }

  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  if (process.env.DRY_RUN === "true") {
    // Paper position: track in state + log the deploy decision so DRY_RUN
    // exercises the full lifecycle (maxPositions gate, occupied-pool/mint
    // filters, manager cycles, OOR bookkeeping) instead of redeploying the
    // same pools every cycle. No transaction is sent; getMyPositions merges
    // these back in via appendDryPositions.
    const dryMinBinId = activeBin.binId - activeBinsBelow;
    const dryMaxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;
    const dryPosition = `DRY-${pool_address.slice(0, 8)}-${Date.now()}`;
    const signalSnapshot = config.darwin?.enabled
      ? getAndClearStagedSignals(pool_address, baseMint)
      : null;
    trackPosition({
      position: dryPosition,
      pool: pool_address,
      pool_name,
      base_mint: baseMint,
      dry: true,
      strategy: activeStrategy,
      strategy_source: strategySource,
      bin_range: { min: dryMinBinId, max: dryMaxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step: bin_step ?? actualBinStep,
      base_fee,
      sw_size_boosted: swSizeBoosted,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      signal_snapshot: signalSnapshot,
      entry_mcap,
      entry_tvl,
      entry_volume,
      entry_holders,
      entry_fee_tvl_fast,
      entry_fee_tvl_slow,
      fee_gate_timeframe,
    });
    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: dryPosition,
      summary: `[DRY RUN] Would deploy ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${dryMinBinId}→${dryMaxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: dryMinBinId,
        max_bin: dryMaxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });
    _positionsCacheAt = 0;
    return {
      dry_run: true,
      position: dryPosition,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        strategy_source: strategySource,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        sw_size_boosted: swSizeBoosted,
        wide_range: totalBins > 69,
      },
      message: `DRY RUN — no transaction sent; tracked as paper position ${dryPosition}`,
    };
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        const signalSnapshot = config.darwin?.enabled
          ? getAndClearStagedSignals(pool_address, baseMint)
          : null;
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          base_mint: baseMint,
          strategy: activeStrategy,
          strategy_source: strategySource,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step: bin_step ?? actualBinStep,
          base_fee: actualBaseFee,
          sw_size_boosted: swSizeBoosted,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
          signal_snapshot: signalSnapshot,
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
          entry_fee_tvl_fast,
          entry_fee_tvl_slow,
          fee_gate_timeframe,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        sw_size_boosted: swSizeBoosted,
        strategy: activeStrategy,
        strategy_source: strategySource,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];
    let partialDeploy = null;

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        // createExtendedEmptyPosition measured at ~19k CU.
        const txHash = await sendTx(createTxArray[i], signers, {
          label: `deploy_create ${i + 1}/${createTxArray.length}`,
          cuLimit: 200_000,
          writableAccounts: poolWritableAccounts(pool),
        });
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs). These txs deposit at
      // active-bin-RELATIVE deltas (rebalanceLiquidity) with a program-side
      // drift tolerance of ceil(slippage% / binStep%) bins, but each tx only
      // carries the bin-array accounts of its planned chunk — active-bin drift
      // across a bin-array edge fails that chunk (InvalidBinArray) while
      // earlier chunks stay live on-chain. Handle per-chunk instead of letting
      // one failed chunk discard the whole deploy as if nothing landed.
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      let executedChunks = 0;
      for (let i = 0; i < addTxArray.length; i++) {
        try {
          // Heaviest tx in the system — measured 453-685k CU on 135-bin chunks.
          const txHash = await sendTx(addTxArray[i], [wallet], {
            label: `deploy_add ${i + 1}/${addTxArray.length}`,
            writableAccounts: poolWritableAccounts(pool),
          });
          txHashes.push(txHash);
          executedChunks++;
          log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
        } catch (chunkError) {
          if (executedChunks === 0) {
            // Nothing deposited — reclaim the position rent and fail cleanly.
            await closeEmptyWidePosition(pool, newPosition.publicKey, wallet);
            throw chunkError;
          }
          // A later chunk failed after liquidity landed: the position is live
          // on-chain with a partial fill. Adopt it deliberately — an untracked
          // position is only half-managed (no deployed_at/age, no OOR timer,
          // no trailing TP; it would only surface via the on-chain scan).
          partialDeploy = {
            failed_chunk: i + 1,
            total_chunks: addTxArray.length,
            error: chunkError.message,
          };
          log(
            "deploy_warn",
            `Add liquidity tx ${i + 1}/${addTxArray.length} failed after ${executedChunks} chunk(s) landed — adopting partial position: ${chunkError.message}`,
          );
          break;
        }
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      // ≤69 bins in one tx — never exercised in era #9 (135 bins always take the
      // wide path) and therefore unmeasured, so keep the full 1.4M block budget.
      const txHash = await sendTx(tx, [wallet, newPosition], {
        label: "deploy_standard",
        cuLimit: 1_400_000,
        writableAccounts: poolWritableAccounts(pool),
      });
      txHashes.push(txHash);
    }

    // Partial fill: read the actual deposit + bin range from the position
    // account so state.json reflects what really landed, not the plan.
    let actualAmountY = finalAmountY;
    let actualBinMin = minBinId;
    let actualBinMax = maxBinId;
    if (partialDeploy) {
      const actual = await readDeployedPositionState(pool, newPosition.publicKey);
      if (actual?.amount_sol != null) actualAmountY = actual.amount_sol;
      if (actual?.lower_bin != null) actualBinMin = actual.lower_bin;
      if (actual?.upper_bin != null) actualBinMax = actual.upper_bin;
      partialDeploy.planned_sol = finalAmountY;
      partialDeploy.deposited_sol = actual?.amount_sol ?? null;
      log(
        "deploy_warn",
        `PARTIAL deploy tracked — ~${actualAmountY} of ${finalAmountY} SOL landed, bins ${actualBinMin}->${actualBinMax}`,
      );
    }

    log("deploy", `${partialDeploy ? "PARTIAL SUCCESS" : "SUCCESS"} — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    const signalSnapshot = config.darwin?.enabled
      ? getAndClearStagedSignals(pool_address, baseMint)
      : null;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      base_mint: baseMint,
      strategy: activeStrategy,
      strategy_source: strategySource,
      bin_range: { min: actualBinMin, max: actualBinMax, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step: bin_step ?? actualBinStep,
      base_fee: actualBaseFee,
      sw_size_boosted: swSizeBoosted,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: actualAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      signal_snapshot: signalSnapshot,
      entry_mcap,
      entry_tvl,
      entry_volume,
      entry_holders,
      entry_fee_tvl_fast,
      entry_fee_tvl_slow,
      fee_gate_timeframe,
      deploy_txs: txHashes,
      notes: partialDeploy
        ? [`Partial wide deploy: add-liquidity chunk ${partialDeploy.failed_chunk}/${partialDeploy.total_chunks} failed; ~${actualAmountY} of planned ${finalAmountY} SOL landed`]
        : [],
    });

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: partialDeploy
        ? `PARTIAL deploy: ~${actualAmountY} of ${finalAmountY} SOL with ${activeStrategy} (chunk ${partialDeploy.failed_chunk}/${partialDeploy.total_chunks} failed)`
        : `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        partialDeploy ? `partial fill — actual bins ${actualBinMin}→${actualBinMax}` : null,
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: actualBinMin, max: actualBinMax, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      sw_size_boosted: swSizeBoosted,
      strategy: activeStrategy,
      strategy_source: strategySource,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: actualAmountY,
      partial: partialDeploy,
      ...(partialDeploy
        ? { warning: `Partial deploy: only ~${actualAmountY} of the planned ${finalAmountY} SOL landed (chunk ${partialDeploy.failed_chunk}/${partialDeploy.total_chunks} failed: ${String(partialDeploy.error).slice(0, 160)}). Position is tracked with actual amounts — do NOT retry the deploy.` }
        : {}),
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  // Prefer the public-infra path (RPC + Jupiter + Meteora deposits) used by getMyPositions.
  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_true_usd: p.pnl_true_usd ?? null,
          pnl_sol: p.pnl_sol ?? null,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error) {
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_true_usd:      roundNum(p.pnlUsd, 4),
      pnl_sol:           roundNum(p.pnlSol, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

function resolvePerformanceSignalSnapshot({ poolAddress, baseMint, tracked }) {
  const staged = config.darwin?.enabled
    ? getAndClearStagedSignals(poolAddress, baseMint)
    : null;
  const snapshot = {
    ...(staged || {}),
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot.base_mint == null) snapshot.base_mint = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked?.[field] != null) {
      snapshot[field] = tracked[field];
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function getClosedPnlValue(posEntry, solMode = false) {
  return solMode
    ? maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0
    : maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
}

function getClosedPnlPct(posEntry, solMode = false) {
  const reported = solMode
    ? maybeNum(posEntry?.pnlSolPctChange) ?? maybeNum(posEntry?.pnl?.percentNative)
    : maybeNum(posEntry?.pnlPctChange) ?? maybeNum(posEntry?.pnl?.percent);
  if (reported != null) return reported;

  const pnl = getClosedPnlValue(posEntry, solMode);
  const deposit = solMode
    ? maybeNum(posEntry?.allTimeDeposits?.total?.sol)
    : maybeNum(posEntry?.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchRawOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await agentMeridianJson(`/positions/open/raw?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 10_000,
    },
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byPosition = {};
  for (const row of rows) {
    const addr = row?.position || row?.id || row?.tokenId;
    if (addr) byPosition[addr] = row;
  }
  return {
    ...payload,
    data: rows,
    byPosition,
  };
}

// ─── Get My Positions ──────────────────────────────────────────
// DRY_RUN paper positions: merge open dry-tracked positions into a getMyPositions
// result so the maxPositions gate, occupied-pool/mint screening filters, and the
// manager cycle all exercise during observation. PnL stays unpriced
// (pnl_pct_suspicious) so PnL-gated rules pause; OOR detection uses the real
// active bin, so the OOR and max-hold rules still fire. Merging BEFORE
// syncOpenPositions keeps sync from auto-closing them while DRY_RUN is on;
// with DRY_RUN off this is a no-op and stale dry positions sync away normally.
async function appendDryPositions(result) {
  if (process.env.DRY_RUN !== "true" || !result?.positions) return result;
  const dryTracked = getTrackedPositions(true).filter((p) => p.dry);
  if (dryTracked.length === 0) return result;
  const have = new Set(result.positions.map((p) => p.position));
  for (const tracked of dryTracked) {
    if (have.has(tracked.position)) continue;
    let activeBinId = null;
    try {
      const pool = await getPool(tracked.pool);
      activeBinId = (await pool.getActiveBin()).binId;
    } catch (e) {
      log("positions_warn", `Dry position ${tracked.position}: active bin fetch failed (${e.message}) — using deploy-time bin`);
      activeBinId = tracked.active_bin_at_deploy ?? null;
    }
    const lowerBin = tracked.bin_range?.min ?? null;
    const upperBin = tracked.bin_range?.max ?? null;
    const inRange = activeBinId != null && lowerBin != null && upperBin != null
      ? activeBinId >= lowerBin && activeBinId <= upperBin
      : true;
    if (inRange) markInRange(tracked.position);
    else markOutOfRange(tracked.position);
    result.positions.push({
      position: tracked.position,
      pool: tracked.pool,
      pair: tracked.pool_name || tracked.pool,
      base_mint: tracked.base_mint ?? null,
      lower_bin: lowerBin,
      upper_bin: upperBin,
      active_bin: activeBinId,
      in_range: inRange,
      unclaimed_fees_usd: 0,
      total_value_usd: null,
      pnl_usd: null,
      pnl_sol: null,
      pnl_pct: null,
      pnl_pct_derived: null,
      pnl_pct_diff: null,
      pnl_pct_suspicious: true,
      fee_per_tvl_24h: null,
      age_minutes: tracked.deployed_at
        ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
        : null,
      minutes_out_of_range: minutesOutOfRange(tracked.position),
      instruction: tracked.instruction ?? null,
      dry: true,
    });
  }
  result.total_positions = result.positions.length;
  return result;
}

// DRY_RUN: only paper positions count toward the maxPositions quota — real
// positions in the shared wallet belong to a live agent elsewhere and would
// otherwise starve the simulation's screening cycles. Live mode counts all.
// Occupied-pool/mint filters intentionally still see the full list.
export function countablePositions(result) {
  const positions = result?.positions || [];
  if (process.env.DRY_RUN === "true") return positions.filter((p) => p.dry).length;
  return positions.length;
}

export async function getMyPositions({ force = false, silent = false, wallet_address = null } = {}) {
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    // ── Primary path: public infra (on-chain RPC + Jupiter + Meteora deposits) ──
    // No LPAgent / agentmeridian dependency, so the poller runs aggressively on
    // fully public resources. Falls through to the Meteora-API path on any error.
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${config.pnl.rpcUrl})...`);
        const rpcResult = await computePositions(walletAddress);
        if (useLocalWallet) {
          await appendDryPositions(rpcResult);
          syncOpenPositions(rpcResult.positions.map((p) => p.position));
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;
      } catch (error) {
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${error.message}`);
      }
    }

    // ── Fallback path: Meteora portfolio + /pnl APIs (no LPAgent) ──
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = {}; // LPAgent removed — Meteora binData only

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        // Gate PnL rules ONLY when the tick is genuinely unpriceable (no real number
        // from either method — e.g. missing deposits / data outage) or when the datapi
        // has indexed only part of a multi-tx wide deploy (understated cost basis →
        // phantom PnL spike; JLY 5 Aug). Reported-vs-derived divergence is normal noise
        // on volatile pools, so it is logged but NOT gated — gating on it froze all
        // exits (stop-loss/trailing/close) and stranded positions.
        const depositsPartial = isDepositPartiallyIndexed(binData, tracked?.amount_sol);
        const pnlPctSuspicious = (reportedPnlPct == null && derivedPnlPct == null) || depositsPartial;
        if (depositsPartial) {
          log("positions_warn", `Partially indexed deposits for ${positionAddress.slice(0, 8)}: indexed=${binData?.allTimeDeposits?.total?.sol ?? "?"} SOL vs tracked=${tracked?.amount_sol} SOL — PnL rules paused this tick`);
        } else if (pnlPctSuspicious) {
          log("positions_warn", `Unpriceable pnl_pct for ${positionAddress.slice(0, 8)}: no valid reported/derived value this tick — PnL rules paused`);
        } else if (pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5)) {
          // Informational only — does not gate rules.
          log("positions_warn", `pnl_pct divergence for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)} (informational)`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          // Always-SOL counterpart so bookkeeping stays dual-denominated regardless of solMode.
          pnl_sol:            lpData
            ? Math.round(safeNum(lpData.pnl?.valueNative) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlSol || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      await appendDryPositions(result);
      syncOpenPositions(result.positions.map(p => p.position));
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) _positionsInflight = null;
  }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_true_usd:       roundNum(p ? p.pnlUsd : 0, 4),
        pnl_sol:            roundNum(p ? p.pnlSol : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      // Claim-only measured 115-124k CU.
      const txHash = await sendTx(tx, [wallet], {
        label: "claim",
        cuLimit: 300_000,
        writableAccounts: poolWritableAccounts(pool),
      });
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
// Step-2-light (exit-slippage): closed-PnL settling + recordPerformance run
// asynchronously after closePosition returns, so the post-close auto-swap in
// executor.js starts without waiting behind the polling (median ~1s, tail ~25s).
// The executor awaits this before attaching exit-execution instrumentation.
const _pendingCloseBookkeeping = new Map();

export async function waitForCloseBookkeeping(position_address, timeoutMs = 60_000) {
  const pending = _pendingCloseBookkeeping.get(position_address);
  if (!pending) return;
  await Promise.race([pending, new Promise((r) => setTimeout(r, timeoutMs))]);
}

export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    // Paper close: mark the dry-tracked position closed in state and log the
    // decision so the manager lifecycle completes. No performance/lesson entry —
    // dry positions have no priced PnL and must not pollute learning data.
    // No base_mint in the result, so the executor's auto-swap stays off.
    const dryTracked = getTrackedPosition(position_address);
    if (dryTracked?.dry && !dryTracked.closed) {
      recordClose(position_address, `${reason || "manual"} (dry run)`);
      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: dryTracked.pool,
        pool_name: dryTracked.pool_name,
        position: position_address,
        summary: `[DRY RUN] Closed paper position${dryTracked.deployed_at ? ` after ${Math.floor((Date.now() - new Date(dryTracked.deployed_at).getTime()) / 60000)}m` : ""}`,
        reason: reason || "manual",
      });
      _positionsCacheAt = 0;
      return {
        success: true,
        dry_run: true,
        position: position_address,
        pool: dryTracked.pool,
        pool_name: `${dryTracked.pool_name || dryTracked.pool} (DRY)`,
        message: "DRY RUN — paper position closed in state only; no transaction sent",
      };
    }
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  // Trailing-exit forensics, captured BEFORE any close tx runs (era #9 task 3).
  const trailingTrace = getTrailingTrace(position_address, config.management.trailingDropPct);
  // Signature ledgers live OUTSIDE the try: an exception mid-close must not take
  // the signatures of the txs that already landed with it (see recordCloseTxAttempt).
  const claimTxHashes = [];
  const closeTxHashes = [];
  // Exit-slippage instrumentation (step 1): timestamps for each close stage so the
  // close→swap latency can be decomposed at review time. Observability only.
  const closeSignalAtMs = Date.now();
  let claimDoneAtMs = null;
  let closeTxDoneAtMs = null;
  // settle_ms covers everything between close-tx confirm and this function returning
  // (5s RPC sleep + close verification). Since step-2-light the closed-PnL polling
  // is async and NO LONGER inside this window — its duration is recorded separately
  // as pnl_settle_ms on the performance entry.
  const buildCloseTiming = () => ({
    signal_at: new Date(closeSignalAtMs).toISOString(),
    claim_done_at: claimDoneAtMs ? new Date(claimDoneAtMs).toISOString() : null,
    close_done_at: closeTxDoneAtMs ? new Date(closeTxDoneAtMs).toISOString() : null,
    returned_at: new Date().toISOString(),
    claim_ms: claimDoneAtMs ? claimDoneAtMs - closeSignalAtMs : null,
    close_ms: closeTxDoneAtMs ? closeTxDoneAtMs - (claimDoneAtMs ?? closeSignalAtMs) : null,
    settle_ms: closeTxDoneAtMs ? Date.now() - closeTxDoneAtMs : null,
    total_ms: Date.now() - closeSignalAtMs,
  });

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
      const pool = await getPool(poolAddress);
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: 5000,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlTrueUsd = 0;
        let pnlSol = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        let withdrawSol = null, depositSol = null, feesSol = null;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlTrueUsd = safeNum(posEntry.pnlUsd);
                pnlSol = getClosedPnlValue(posEntry, true);
                pnlUsd = config.management.solMode ? pnlSol : pnlTrueUsd;
                pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                withdrawSol = parseFloat(posEntry.allTimeWithdrawals?.total?.sol || 0);
                depositSol = parseFloat(posEntry.allTimeDeposits?.total?.sol || 0);
                feesSol = parseFloat(posEntry.allTimeFees?.total?.sol || 0);
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
        const signalSnapshot = resolvePerformanceSignalSnapshot({
          poolAddress,
          baseMint: closeBaseMint,
          tracked,
        });

        let exitMarket = {};
        try {
          const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
          const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
          const ep = exitDetail?.data?.[0];
          if (ep) {
            exitMarket = {
              exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
              exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
              exit_volume: parseFloat(ep?.volume) || null,
            };
          }
        } catch { /* non-blocking */ }

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: closeBaseMint,
          strategy: tracked.strategy,
          strategy_source: tracked.strategy_source ?? null,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          base_fee: tracked.base_fee ?? null,
          sw_size_boosted: tracked.sw_size_boosted ?? false,
          volatility: tracked.volatility ?? null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          pnl_sol: Math.round(pnlSol * 10000) / 10000,
          withdrawals_sol: withdrawSol,
          deposits_sol: depositSol,
          fees_earned_sol: feesSol,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          signal_snapshot: signalSnapshot,
          entry_mcap: tracked.entry_mcap ?? null,
          entry_tvl: tracked.entry_tvl ?? null,
          entry_volume: tracked.entry_volume ?? null,
          entry_holders: tracked.entry_holders ?? null,
          // Dual-log of the fee/TVL gate: fast = the 5m sample, slow = the 30m
          // window the gate actually reads. Kept on the performance entry so
          // window attribution needs lessons.json alone, no state.json join.
          entry_fee_tvl_fast: tracked.entry_fee_tvl_fast ?? null,
          entry_fee_tvl_slow: tracked.entry_fee_tvl_slow ?? null,
          fee_gate_timeframe: tracked.fee_gate_timeframe ?? null,
          ...exitMarket,
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_true_usd: pnlTrueUsd,
            pnl_sol: pnlSol,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_true_usd: pnlTrueUsd,
          pnl_sol: pnlSol,
          pnl_pct: pnlPct,
          base_mint: closeBaseMint,
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      };
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    // Snapshot the position from the last cached read BEFORE the close txs —
    // used for the provisional PnL in the return value and as the bookkeeping
    // fallback (after close verification refreshes the cache, the closed
    // position is gone from it).
    const preCloseSnap = _positionsCache?.positions?.find((p) => p.position === position_address) || null;

    const positionPubKey = new PublicKey(position_address);
    // Submit one close-path tx, recording the signature in state BEFORE we know
    // the outcome and re-attaching it to the error on failure. A timed-out tx is
    // still a submitted tx: it may have landed, and either way the cash
    // reconciliation has to know it exists.
    const sendClosePathTx = async (tx, { label, cuLimit, bucket }) => {
      let signature = null;
      try {
        signature = await sendTx(tx, [wallet], {
          label,
          cuLimit,
          writableAccounts: poolWritableAccounts(pool),
        });
        bucket.push(signature);
        recordCloseTxAttempt(position_address, signature);
        return signature;
      } catch (error) {
        if (error.signature) {
          recordCloseTxAttempt(position_address, error.signature);
          error.close_path_signature = error.signature;
        }
        throw error;
      }
    };

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            await sendClosePathTx(tx, { label: "close_claim", cuLimit: 300_000, bucket: claimTxHashes });
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
          // Stamp last_claim_at so a RETRY of this close skips step 1 entirely.
          // Without it the retry re-ran claimSwapFee on an already-drained
          // position and logged "No fee to claim" — wasted tx, wasted time, and
          // the exact signature of a non-idempotent retry (7 Aug three-SOL).
          recordClaim(position_address);
        }
      }
      claimDoneAtMs = Date.now();
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    // Read the CURRENT on-chain bin state every attempt and only work the bins
    // that still hold liquidity, so a retry after a partially-executed close
    // resumes where the previous attempt stopped instead of replaying it.
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        const liquidBins = bins.filter((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
        hasLiquidity = liquidBins.length > 0;
        if (hasLiquidity && liquidBins.every((bin) => bin.binId != null)) {
          const ids = liquidBins.map((bin) => Number(bin.binId));
          closeFromBinId = Math.min(...ids);
          closeToBinId = Math.max(...ids);
          if (liquidBins.length < bins.length) {
            log("close", `Step 2: ${liquidBins.length}/${bins.length} bins still hold liquidity — removing ${closeFromBinId}..${closeToBinId} only`);
          }
        }
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const closeTxArray = Array.isArray(closeTx) ? closeTx : [closeTx];
      for (let i = 0; i < closeTxArray.length; i++) {
        // remove+claim+close measured 375-388k CU on 135-bin positions.
        await sendClosePathTx(closeTxArray[i], {
          label: `close_remove ${i + 1}/${closeTxArray.length}`,
          cuLimit: 700_000,
          bucket: closeTxHashes,
        });
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      await sendClosePathTx(closeTx, { label: "close_account", cuLimit: 200_000, bucket: closeTxHashes });
    }
    closeTxDoneAtMs = Date.now();
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        close_tx_attempts: getCloseTxAttempts(position_address),
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const closeBaseMint = pool.lbPair.tokenXMint.toString();

      // Provisional PnL for the immediate return value — from the pre-close
      // cached snapshot. The settled numbers are fetched in the async block
      // below (step-2-light): the post-close auto-swap in executor.js no longer
      // waits behind the closed-PnL polling. lessons.json still gets the
      // authoritative numbers; the reconciler patches any stragglers.
      const solMode = config.management.solMode;
      const provTrueUsd = preCloseSnap ? (preCloseSnap.pnl_true_usd ?? (solMode ? 0 : preCloseSnap.pnl_usd) ?? 0) : 0;
      const provSol     = preCloseSnap ? (preCloseSnap.pnl_sol ?? (solMode ? (preCloseSnap.pnl_usd ?? 0) : 0)) : 0;
      const provUsd     = solMode ? (preCloseSnap?.pnl_usd ?? 0) : provTrueUsd;
      const provPct     = preCloseSnap?.pnl_pct ?? 0;

      // Async bookkeeping: settled-PnL fetch → recordPerformance → decision log.
      // Body keeps its original indentation — it was inline before step-2-light.
      const bookkeeping = (async () => {
      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlSol = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      let withdrawSol = null, depositSol = null, feesSol = null;
      const pnlSettleStartMs = Date.now();
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlSol = getClosedPnlValue(posEntry, true);
              const nextPnlValue = config.management.solMode ? nextPnlSol : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
              // SOL-native counterparts. The wallet is SOL-denominated, so these
              // are the figures the on-chain cash reconciliation can be compared
              // against; the USD ones drift with the SOL price during the hold.
              const nextWithdrawSol = parseFloat(posEntry.allTimeWithdrawals?.total?.sol || 0);
              const nextDepositSol = parseFloat(posEntry.allTimeDeposits?.total?.sol || 0);
              const nextFeesSol = parseFloat(posEntry.allTimeFees?.total?.sol || 0);

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlSol        = nextPnlSol;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                withdrawSol   = nextWithdrawSol;
                depositSol    = nextDepositSol;
                feesSol       = nextFeesSol;
                log("close", `Closed PnL from API: pnl=${pnlTrueUsd.toFixed(2)} USD / ${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD / ${withdrawSol.toFixed(4)} SOL, deposited=${initialUsd.toFixed(2)} USD`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      const pnlSettleMs = Date.now() - pnlSettleStartMs;
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = preCloseSnap;
        if (cachedPos) {
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlSol        = cachedPos.pnl_sol ?? (config.management.solMode ? (cachedPos.pnl_usd ?? 0) : 0);
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      let exitMarket = {};
      try {
        const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
        const ep = exitDetail?.data?.[0];
        if (ep) {
          exitMarket = {
            exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
            exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
            exit_volume: parseFloat(ep?.volume) || null,
          };
        }
      } catch { /* non-blocking */ }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        strategy_source: tracked.strategy_source ?? null,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        base_fee: tracked.base_fee ?? null,
        sw_size_boosted: tracked.sw_size_boosted ?? false,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        pnl_sol: Math.round(pnlSol * 10000) / 10000,
        // SOL-native trio from Meteora — the basis for liquidation_gap_sol and
        // (for fees) the piece /pnl still has to approximate at current price.
        withdrawals_sol: withdrawSol,
        deposits_sol: depositSol,
        fees_earned_sol: feesSol,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        // Dual-log of the fee/TVL gate: fast = the 5m sample, slow = the 30m
        // window the gate actually reads. Kept on the performance entry so
        // window attribution needs lessons.json alone, no state.json join.
        entry_fee_tvl_fast: tracked.entry_fee_tvl_fast ?? null,
        entry_fee_tvl_slow: tracked.entry_fee_tvl_slow ?? null,
        fee_gate_timeframe: tracked.fee_gate_timeframe ?? null,
        pnl_settle_ms: pnlSettleMs,
        // Trailing-exit forensics (era #9 task 3). Present on every close so the
        // healthy trailing exits provide the baseline the overshoots are measured
        // against; null-ish on closes that never armed trailing.
        ...(trailingTrace || {}),
        ...exitMarket,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_true_usd: pnlTrueUsd,
          pnl_sol: pnlSol,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });
      })().catch((e) => {
        log("close_warn", `Async close bookkeeping failed for ${position_address.slice(0, 8)}: ${e.message}`);
      });
      _pendingCloseBookkeeping.set(position_address, bookkeeping);
      bookkeeping.finally(() => {
        setTimeout(() => _pendingCloseBookkeeping.delete(position_address), 60_000);
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        close_tx_attempts: getCloseTxAttempts(position_address),
        txs: txHashes,
        pnl_usd: provUsd,
        pnl_true_usd: provTrueUsd,
        pnl_sol: provSol,
        pnl_pct: provPct,
        pnl_provisional: true,
        base_mint: closeBaseMint,
        close_timing: buildCloseTiming(),
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      close_tx_attempts: getCloseTxAttempts(position_address),
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
      close_timing: buildCloseTiming(),
    };
  } catch (error) {
    log("close_error", error.message);
    // The failure path MUST carry the signatures too. Everything submitted so far
    // is also in state.close_tx_attempts, but the executor reconciles the union of
    // both — a caller that only ever sees `{success:false, error}` is how -8.3 SOL
    // of phantom losses got booked in era #9.
    const attempts = getCloseTxAttempts(position_address);
    return {
      success: false,
      error: error.message,
      position: position_address,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      close_tx_attempts: attempts,
      txs: [...new Set([...claimTxHashes, ...closeTxHashes, ...attempts])],
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
