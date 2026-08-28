// ledger-transport.js — how one wallet's ledger is READ (§08).
//
// This is the ONLY module that knows a ledger might live behind fs vs https
// vs a database. Today both daemons share one machine, so the single
// implemented kind is "fs"; a wallet on another VPS later means adding
// { kind: "https", url } to its registry entry and ONE new reader here — the
// ledger format itself never changes, and no caller ever branches on kind.
//
// Read-only by design: the consolidator is purely a reader (every daemon
// writes exactly one ledger — its own), so this module must never gain a
// write path.

import os from "os";
import path from "path";
import { readJsonStore } from "./utils/json-store.js";
import { resolveLedgerDir } from "./equity-snapshot.js";

const expandHome = (p) => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));

/**
 * Read one wallet's ledger → { snapshots, periods, dir }. Missing files are a
 * legitimate empty ledger (the daemon has not started yet — the consolidator
 * reports it via wallets_missing instead of crashing); corrupt files THROW
 * from readJsonStore, never silently emptied.
 *
 * transport.path is optional for kind "fs": it defaults to
 * <ledgerDir>/<address>, the exact location equity-snapshot.js writes to, so
 * same-machine registry entries stay one line.
 */
export function readLedger(walletEntry) {
  const kind = walletEntry.transport?.kind ?? "fs";
  if (kind !== "fs") {
    throw new Error(
      `Transport "${kind}" untuk wallet "${walletEntry.id}" belum diimplementasikan — hari ini cuma "fs" (§08)`,
    );
  }
  const dir = walletEntry.transport?.path
    ? expandHome(walletEntry.transport.path)
    : path.join(resolveLedgerDir(), walletEntry.address);
  const snapshots = readJsonStore(path.join(dir, "snapshots.json"), {
    version: 1,
    address: walletEntry.address,
    snapshots: [],
  }).snapshots;
  const periods = readJsonStore(path.join(dir, "periods.json"), {
    version: 1,
    address: walletEntry.address,
    periods: [],
  }).periods;
  return { snapshots, periods, dir };
}
