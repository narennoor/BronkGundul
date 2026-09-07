// utils/chain-flows.js — on-chain cash-flow primitives shared by the /pnl
// report and the equity ledger (equity-snapshot.js and everything above it).
//
// Extracted from pnl-report.js so the financial-report path (daily snapshots →
// sealed periods → consolidated reports) can walk and classify flows WITHOUT
// importing pnl-report.js. That import ban is deliberate: pnl-report owns the
// full-history walk, and the ledger's zero-walk rule says report code must
// never be one import away from re-walking the chain. The only RECURRING
// sanctioned fetchAllTxs caller on the ledger path is equity-snapshot.js, and
// its stopBeforeSec is ALWAYS derived from the previous snapshot — never from
// a constant, never from config. The single exception is the ONE-SHOT history
// seed (equity-seed.js, fase 6) — one full walk per wallet to establish the
// first anchor, never imported by report code, never run by cron.

import { heliusFetch, heliusKeyRing, activeRpcUrl, rpcFetch } from "./helius-keys.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_DELAY_MS = 250;
const MAX_PAGE_DELAY_MS = 2000;

/**
 * One Helius page, with backoff. A bare 429 used to abort the whole report —
 * the wallet is thousands of txs deep, so a single walk is 60+ requests and the
 * consistency loop could triple that. Rate limits are expected here, not
 * exceptional; honor Retry-After when the server sends one.
 */
export async function fetchTxPage(url, { retries = 5 } = {}) {
  // `url` may be a (key) => url builder: heliusFetch then swaps to the backup
  // key on a quota response BEFORE any sleep below — the backoff only runs
  // once every key in the ring is limited. A plain string never rotates.
  const makeUrl = typeof url === "function" ? url : null;
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    const res = makeUrl ? await heliusFetch(makeUrl) : await fetch(url);
    if (res.ok) return { batch: await res.json(), throttled: attempt > 0 };
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Helius ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
    if (attempt >= retries) {
      throw new Error(
        `Helius ${res.status} setelah ${retries} percobaan — rate limit belum reda, coba lagi beberapa menit lagi`,
      );
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait);
    wait = Math.min(wait * 2, 15000);
  }
}

/**
 * Walk the wallet history newest-first.
 *
 * `stopBeforeSec` (the cutoff) ends the walk as soon as a page reaches past it:
 * pre-cutoff txs contribute nothing but an opening balance, and that is derived
 * from the current balance instead. Without it, every /pnl re-walked the entire
 * chain history — unbounded in both Helius credits and wall clock.
 *
 * `known` short-circuits the consistency loop's later attempts: when the walk
 * reaches a signature already held, the rest of the previous walk is still
 * valid, so only the newly-landed txs are refetched. NOTE for ledger callers:
 * this stop fires at the FIRST known signature, i.e. the newest — a
 * late-indexed tx whose blocktime is older than that sits deeper in the page
 * order and would never be reached. The snapshot overlap-walk therefore does
 * NOT pass `known`; it dedupes client-side against the previous snapshot's
 * recorded signatures instead.
 *
 * Returns `complete` (the walk ran off the end of history — the strong
 * flowSum === balance check is available) and `reachedCutoff` (we paged back
 * past the cutoff — the in-scope window is whole).
 */
export async function fetchAllTxs(wallet, heliusKey, { stopBeforeSec = null, known = null, maxPages = 100 } = {}) {
  const txs = [];
  let before;
  let pageDelay = PAGE_DELAY_MS;
  // maxPages 100 (10k txs) covers every recurring caller; only the one-shot
  // seed (equity-seed.js) raises it — its cutoff reaches weeks back.
  // An explicit key that is not in the ring (a foreign key handed in by a
  // script) is used as-is; otherwise the ring decides which key is active and
  // the page fetch rotates to the backup on a 429.
  const rotate = !heliusKey || heliusKeyRing().includes(heliusKey);
  for (let page = 0; page < maxPages; page++) {
    const makeUrl = (key) => {
      const url = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
      url.searchParams.set("api-key", key);
      url.searchParams.set("limit", "100");
      if (before) url.searchParams.set("before", before);
      return url.toString();
    };
    const { batch, throttled } = await fetchTxPage(rotate ? makeUrl : makeUrl(heliusKey));
    // A throttled page means we are pushing too hard; stay slower for the rest
    // of the walk rather than earning another 429 on the very next request.
    if (throttled) pageDelay = Math.min(pageDelay * 2, MAX_PAGE_DELAY_MS);
    if (!batch.length) return { txs, complete: true, reachedCutoff: true, resumed: false };
    if (known?.size) {
      const hit = batch.findIndex((t) => known.has(t.signature));
      if (hit >= 0) {
        txs.push(...batch.slice(0, hit));
        return { txs, complete: false, reachedCutoff: true, resumed: true };
      }
    }
    txs.push(...batch);
    if (stopBeforeSec != null && batch.some((t) => t.timestamp < stopBeforeSec)) {
      return { txs, complete: false, reachedCutoff: true, resumed: false };
    }
    before = batch[batch.length - 1].signature;
    await sleep(pageDelay);
  }
  return { txs, complete: false, reachedCutoff: false, resumed: false };
}

export async function fetchBalance(wallet) {
  // rpcFetch rotates the api-key on a quota response; a non-Helius RPC_URL
  // (no api-key param) passes straight through to fetch.
  const res = await rpcFetch(activeRpcUrl() || process.env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC getBalance: ${json.error.message}`);
  return json.result.value / 1e9;
}

export async function fetchSolPrice() {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const price = (await res.json())?.[SOL_MINT]?.usdPrice;
  if (!price) throw new Error("Gagal ambil harga SOL dari Jupiter Price API");
  return price;
}

export async function fetchLlmUsage() {
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
 * Kas prabayar OpenRouter level AKUN (bukan per key): total kredit yang pernah
 * dibeli + total terpakai SEMUA key akun itu — terbaca dengan key inference
 * biasa (dibuktikan 28 Agu 2026). Memo untuk blok KAS LLM di laporan; gagal =
 * null, tidak pernah fatal — pola yang sama dengan fetchLlmUsage.
 */
export async function fetchLlmCredits() {
  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const d = (await res.json())?.data;
    if (!Number.isFinite(d?.total_credits) || !Number.isFinite(d?.total_usage)) return null;
    return { total_credits_usd: d.total_credits, total_usage_usd: d.total_usage };
  } catch {
    return null;
  }
}

export function walletChange(tx, wallet) {
  const entry = (tx.accountData || []).find((a) => a.account === wallet);
  return entry ? entry.nativeBalanceChange / 1e9 : 0;
}

/**
 * Gas, plus the only two flows that change how much of the operator's own money
 * is in play: SOL funded in from outside, and SOL taken back out.
 *
 * The decisive test is that the tx moves NO tokens. Helius's enhanced `type` is
 * not trustworthy on its own — a Meteora add-liquidity tx (program `LBUZ…`) that
 * wraps SOL through the system program is typed `TRANSFER/SYSTEM_PROGRAM`, and
 * looks exactly like a plain transfer unless you check its token legs. Trusting
 * the label booked 164 position deposits — 87.24 SOL — as money withdrawn from
 * the wallet (26 Aug 2026: "Deposit netto -81.7779", which then flowed into
 * every downstream row and showed +85.9 SOL of phantom profit).
 *
 * A genuine funding transfer carries no token legs at all: system program in,
 * SOL out, nothing else. Anything with a token leg is the agent trading — a
 * deploy, a claim, a swap fill — and is internal to the cycle, not capital
 * entering or leaving.
 *
 * `transfers[]` records every counted funding transfer with its signature and
 * counterparty (`via: "program"` marks an outflow that went through a program
 * rather than a bare system transfer — see isProgramWithdrawal). The equity ledger persists these per daily window: they are the
 * only thing that makes internal-transfer elimination between the group's own
 * wallets deterministic (pair by signature, not by amount + time), and they
 * cannot be reconstructed later without re-walking the chain.
 */
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

/** True when any top-level or inner instruction of a Helius enhanced tx hits the Meteora DLMM program. */
function touchesDlmm(t) {
  if (t.source === "METEORA") return true;
  for (const ins of t.instructions || []) {
    if (ins.programId === DLMM_PROGRAM_ID) return true;
    for (const inner of ins.innerInstructions || []) if (inner.programId === DLMM_PROGRAM_ID) return true;
  }
  return false;
}

/**
 * A token-free SOL outflow the wallet signed and paid for, sent through some
 * program other than Meteora, to an account that is not one of our own. Helius
 * types these `UNKNOWN`, so the `TRANSFER` gate alone misses them: 6 Sep 2026
 * 11:36 UTC the operator deposited 4.7997 SOL into a protocol from Phantom
 * (program 99vQwtBw…, instruction `DepositNative`, Lighthouse guard) while the
 * daemon was paused, and the ledger booked it as −4.8 SOL of trading loss —
 * the W36 seal went out with net_rill −6.28 instead of ≈ −1.5.
 *
 * Position rent is the outflow this must NOT catch. Every rent payment the
 * agent makes goes through a DLMM instruction (`INITIALIZE_POSITION` on the
 * standard path, `createExtendedEmptyPosition` on the retired wide path), so
 * "does the tx touch LBUZ…" is the decisive test; `ownAccounts` is a second
 * guard for callers that know their position addresses.
 */
function isProgramWithdrawal(t, nt, wallet, ownAccounts) {
  if (!Array.isArray(t.instructions)) return false; // shape unknown — stay conservative
  if (touchesDlmm(t)) return false;
  if (nt.toUserAccount === wallet) return false;
  if (ownAccounts && ownAccounts.has(nt.toUserAccount)) return false;
  return true;
}

export function classifyCashFlows(txs, wallet, { ownAccounts = null } = {}) {
  let gasSol = 0, gasTxn = 0, depositIn = 0, withdrawOut = 0;
  const transfers = [];
  for (const t of txs) {
    if (t.feePayer === wallet) { gasSol += t.fee / 1e9; gasTxn++; }
    const movesTokens = (t.tokenTransfers || []).length > 0;
    if (movesTokens) continue;
    for (const nt of t.nativeTransfers || []) {
      if (nt.amount <= 5e6) continue;
      if (nt.toUserAccount === wallet && t.feePayer !== wallet) {
        depositIn += nt.amount / 1e9;
        transfers.push({
          sig: t.signature, ts: t.timestamp, dir: "in",
          counterparty: nt.fromUserAccount, amount_sol: nt.amount / 1e9,
        });
      }
      // The type check stays as a second gate on the way out: rent paid to open
      // a position account is a token-free SOL outflow too, and it is NOT a
      // withdrawal.
      if (nt.fromUserAccount === wallet && t.feePayer === wallet) {
        const plain = t.type === "TRANSFER";
        if (plain || isProgramWithdrawal(t, nt, wallet, ownAccounts)) {
          withdrawOut += nt.amount / 1e9;
          transfers.push({
            sig: t.signature, ts: t.timestamp, dir: "out",
            counterparty: nt.toUserAccount, amount_sol: nt.amount / 1e9,
            ...(plain ? {} : { via: "program", program: (t.instructions || []).map((i) => i.programId).find((id) => !/^ComputeBudget/.test(id)) ?? null }),
          });
        }
      }
    }
  }
  return { gasSol, gasTxn, depositIn, withdrawOut, transfers };
}
