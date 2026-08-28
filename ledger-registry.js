// ledger-registry.js — the wallet registry of the consolidated ledger (§08).
//
// ~/.meridian/ledger-registry.json is the ONLY file edited by hand when a
// wallet joins or retires: adding wallet #3 is one entry here, zero code.
// Everything in it is operator-declared truth (who is in the group, since
// when, where its ledger lives); this module only reads and validates it.
//
// Activity window semantics: `active_from` is the wallet's first active DATE
// and `active_to` its last active DATE, both inclusive calendar days — an
// operator writes "dipensiunkan 2026-09-15" meaning the 15th still counts.
// Internally that becomes the half-open ms window
// [active_from 00:00Z, (active_to + 1 day) 00:00Z), consistent with every
// other period boundary in the ledger.

import os from "os";
import path from "path";
import { config } from "./config.js";
import { readJsonStore } from "./utils/json-store.js";

const DAY_MS = 24 * 3600 * 1000;

const expandHome = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));

/**
 * Where the registry lives. MERIDIAN_REGISTRY_PATH wins (the unit-test suite
 * points it into its temp tree — the registry, like the ledger, sits outside
 * repoPath(), so MERIDIAN_STATE_DIR alone would not isolate it); otherwise
 * config.report.registryPath with `~` expanded. Resolved at call time so a
 * test that sets the env var before a dynamic import is always honored.
 */
export function resolveRegistryPath() {
  if (process.env.MERIDIAN_REGISTRY_PATH) return path.resolve(process.env.MERIDIAN_REGISTRY_PATH);
  return expandHome(config.report?.registryPath || "~/.meridian/ledger-registry.json");
}

function parseDateMs(v, field, walletId) {
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || !Number.isFinite(ms)) {
    throw new Error(`Registry: ${field} wallet "${walletId}" tidak valid ("${v}") — format YYYY-MM-DD`);
  }
  return ms;
}

/**
 * Load and validate the registry. A MISSING file throws with a setup hint —
 * consolidation without a registry is a configuration error, not an empty
 * group; an existing-but-corrupt file throws from readJsonStore as usual.
 */
export function loadRegistry() {
  const file = resolveRegistryPath();
  const raw = readJsonStore(file, null);
  if (raw == null) {
    throw new Error(
      `Registry ${file} belum ada — buat dengan bentuk §08 ` +
      `{ version: 1, group_name, primary, wallets: [{ id, address, label, transport, active_from, active_to }] }`,
    );
  }
  if (raw.version !== 1) throw new Error(`Registry ${file}: version ${raw.version} tidak dikenal (harus 1)`);
  if (!Array.isArray(raw.wallets) || !raw.wallets.length) {
    throw new Error(`Registry ${file}: wallets kosong`);
  }
  const ids = new Set();
  const addrs = new Set();
  for (const w of raw.wallets) {
    if (!w.id || typeof w.id !== "string") throw new Error(`Registry ${file}: wallet tanpa id`);
    if (ids.has(w.id)) throw new Error(`Registry ${file}: id "${w.id}" ganda`);
    ids.add(w.id);
    if (!w.address || typeof w.address !== "string") throw new Error(`Registry ${file}: wallet "${w.id}" tanpa address`);
    if (addrs.has(w.address)) throw new Error(`Registry ${file}: address ${w.address} ganda`);
    addrs.add(w.address);
    const kind = w.transport?.kind ?? "fs";
    if (typeof kind !== "string" || !kind) throw new Error(`Registry ${file}: transport.kind wallet "${w.id}" tidak valid`);
    const fromMs = parseDateMs(w.active_from, "active_from", w.id);
    if (w.active_to != null && parseDateMs(w.active_to, "active_to", w.id) < fromMs) {
      throw new Error(`Registry ${file}: active_to wallet "${w.id}" sebelum active_from`);
    }
  }
  if (!ids.has(raw.primary)) {
    throw new Error(`Registry ${file}: primary "${raw.primary}" tidak ada di wallets[]`);
  }
  return raw;
}

/** Half-open activity window [fromMs, toMs|null) of one registry entry. */
export function activeBoundsMs(walletEntry) {
  const fromMs = Date.parse(`${walletEntry.active_from}T00:00:00Z`);
  const toMs =
    walletEntry.active_to != null
      ? Date.parse(`${walletEntry.active_to}T00:00:00Z`) + DAY_MS // inclusive last day
      : null;
  return [fromMs, toMs];
}

/** Wallets active at the instant `ts` (epoch ms). */
export function activeWalletsAt(ts, registry = null) {
  registry ??= loadRegistry();
  return registry.wallets.filter((w) => {
    const [fromMs, toMs] = activeBoundsMs(w);
    return ts >= fromMs && (toMs == null || ts < toMs);
  });
}

/** Wallets whose activity window overlaps [fromMs, toMs) at all. */
export function walletsActiveIn(fromMs, toMs, registry = null) {
  registry ??= loadRegistry();
  return registry.wallets.filter((w) => {
    const [aFrom, aTo] = activeBoundsMs(w);
    return aFrom < toMs && (aTo == null || aTo > fromMs);
  });
}

/** Every group wallet address, as a Set — the internal-transfer test (§08). */
export function ownAddressSet(registry = null) {
  registry ??= loadRegistry();
  return new Set(registry.wallets.map((w) => w.address));
}

/** Is `addr` one of the group's own wallets? */
export function isOwnWallet(addr, registry = null) {
  return ownAddressSet(registry).has(addr);
}
