// Token-2022 transfer-fee lookup for the screening hard filter (`maxTransferFeeBps`).
//
// Why this exists (NEARKAT-SOL, 16 Sep 2026): the mint carried a 300 bps
// TransferFeeConfig. Meteora books withdrawals + fees GROSS, before the fee, so
// its record showed +1.90% while the wallet netted +0.74% — the token leg paid
// 3% on the way out of the pool and 3% again into the Jupiter swap, ~6% of the
// leg, more than the whole trailing-TP gain. The fee is deterministic and is
// readable from the mint account before deploy, so it belongs in the funnel,
// not in the post-mortem.
//
// Fail-open on RPC trouble in screening (unknown → pass, logged); the deploy
// safety check in executor.js decides its own policy.

import { Connection, PublicKey } from "@solana/web3.js";
import { activeRpcUrl, rpcConnectionConfig, rpcConnectionKey } from "../utils/helius-keys.js";
import { log } from "../logger.js";

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const CACHE_TTL_MS = 15 * 60 * 1000; // a TransferFeeConfig change is an authority tx — rare
const BATCH_SIZE = 100; // getMultipleAccounts hard limit
const _cache = new Map(); // mint → { bps, program, at }

let _connection = null;
let _connectionKey = null;
function getConnection() {
  const key = rpcConnectionKey();
  if (!_connection || key !== _connectionKey) {
    _connection = new Connection(activeRpcUrl() || process.env.RPC_URL, rpcConnectionConfig("confirmed"));
    _connectionKey = key;
  }
  return _connection;
}

/**
 * Pure: derive the transfer fee in bps from a jsonParsed mint account.
 *
 * @param {object|null} account  `{ owner, data: { parsed: { info } } }` as returned by
 *   getParsedAccountInfo / getMultipleParsedAccounts (`value[i]`). null = account missing.
 * @param {number|null} epoch    current epoch; picks `newerTransferFee` once it is in
 *   effect, `olderTransferFee` before that. null → newer (conservative).
 * @returns {{ bps: number, program: "spl-token"|"token-2022"|"unknown" } | null}
 *   null only when the account is missing/unparseable (caller decides fail-open/closed).
 */
export function parseTransferFeeBps(account, epoch = null) {
  if (!account) return null;
  const owner = String(account.owner ?? "");
  const program = owner === TOKEN_2022_PROGRAM_ID ? "token-2022" : owner ? "spl-token" : "unknown";
  if (program !== "token-2022") return { bps: 0, program };
  const info = account.data?.parsed?.info;
  if (!info || typeof info !== "object") return null;
  const ext = (Array.isArray(info.extensions) ? info.extensions : []).find((e) => e?.extension === "transferFeeConfig");
  if (!ext) return { bps: 0, program };
  const newer = ext.state?.newerTransferFee;
  const older = ext.state?.olderTransferFee;
  const useNewer = newer && (epoch == null || newer.epoch == null || Number(epoch) >= Number(newer.epoch));
  const pick = useNewer ? newer : older ?? newer;
  const bps = Number(pick?.transferFeeBasisPoints);
  return { bps: Number.isFinite(bps) ? bps : 0, program };
}

/**
 * Batched transfer-fee lookup with a 15-min cache.
 * @param {string[]} mints
 * @param {{ force?: boolean, connection?: Connection }} [opts]
 * @returns {Promise<Map<string, { bps: number, program: string } | null>>}
 *   null value = lookup failed / account missing for that mint.
 */
export async function getTransferFeeBps(mints, { force = false, connection = null } = {}) {
  const now = Date.now();
  const out = new Map();
  const wanted = [];
  for (const mint of [...new Set((mints || []).filter(Boolean))]) {
    const hit = _cache.get(mint);
    if (!force && hit && now - hit.at < CACHE_TTL_MS) {
      out.set(mint, { bps: hit.bps, program: hit.program });
    } else {
      wanted.push(mint);
    }
  }
  if (wanted.length === 0) return out;

  const conn = connection || getConnection();
  let epoch = null;
  try {
    epoch = (await conn.getEpochInfo("confirmed"))?.epoch ?? null;
  } catch {
    // newer/older only differ for one epoch after an authority change — newer is fine.
  }

  for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
    const chunk = wanted.slice(i, i + BATCH_SIZE);
    let keys;
    try {
      keys = chunk.map((m) => new PublicKey(m));
    } catch (error) {
      log("transfer_fee", `Invalid mint in batch: ${error.message}`);
      for (const m of chunk) out.set(m, null);
      continue;
    }
    try {
      const res = await conn.getMultipleParsedAccounts(keys, { commitment: "confirmed" });
      const values = res?.value ?? [];
      chunk.forEach((mint, j) => {
        const parsed = parseTransferFeeBps(values[j] ?? null, epoch);
        if (parsed) _cache.set(mint, { ...parsed, at: now });
        out.set(mint, parsed);
      });
    } catch (error) {
      log("transfer_fee", `Mint lookup failed for ${chunk.length} mint(s): ${error.message}`);
      for (const m of chunk) out.set(m, null);
    }
  }
  return out;
}

/** Filter verdict shared by screening and the deploy safety check. */
export function transferFeeRejectReason(bps, maxBps) {
  if (maxBps == null) return null; // filter off
  const max = Number(maxBps);
  if (!Number.isFinite(max) || max < 0) return null;
  if (bps == null) return null; // unknown → caller's policy
  if (Number(bps) > max) return `transfer fee ${bps} bps above maxTransferFeeBps ${max}`;
  return null;
}

export function _resetTransferFeeCache() {
  _cache.clear();
}
