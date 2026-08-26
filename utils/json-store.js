// Atomic JSON persistence for the state files at the repo root.
//
// Every store used to call `fs.writeFileSync(FILE, JSON.stringify(...))`, which
// truncates the file and then fills it. Inside the daemon that is safe — writes
// and reads are serialised by the event loop — but ANY other process reading at
// that moment sees a half-written file. state.json is ~2.8 MB and the PnL poller
// rewrites it every ~3 seconds, so the window is wide open: on 26 Aug 2026 a
// plain `JSON.parse(state.json)` from an analysis script failed with
// "SyntaxError ... at position 466918" while the file itself was perfectly fine.
// cli.js, scripts/*, and the reconcilers are all such readers.
//
// Write to a sibling temp file, fsync it, then rename. rename(2) is atomic
// within a filesystem, so a reader sees either the whole old file or the whole
// new one — never a seam. The temp file is a sibling (not /tmp) so the rename
// never crosses a device boundary, which would silently degrade into copy.

import fs from "fs";
import path from "path";

let counter = 0;

/**
 * Serialise `value` and replace `filePath` with it atomically.
 * Throws on failure — and on failure the existing file is left untouched,
 * which is the other half of the point: a JSON.stringify that throws used to
 * leave a truncated file behind.
 */
export function writeJsonAtomic(filePath, value, { spaces = 2 } = {}) {
  const json = JSON.stringify(value, null, spaces);
  // Serialising BEFORE touching the filesystem is deliberate: a circular
  // reference now throws with the old file still intact.
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${counter++}`,
  );
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, json);
    // Flush before the rename: without it a crash can leave the renamed name
    // pointing at unwritten blocks, i.e. an empty file where state used to be.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Read and parse a JSON store.
 *
 * A MISSING file returns `fallback` — that is a legitimate first run. A file
 * that exists but will not parse does NOT: it is retried, and if it still
 * fails the error is thrown. The old behaviour returned the empty fallback for
 * both, so one unreadable read of state.json produced `{positions:{}}` and the
 * very next save wrote that back — turning a transient read error into the
 * permanent loss of every tracked position.
 */
export function readJsonStore(filePath, fallback, { retries = 2 } = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      if (!raw.trim()) return fallback;   // empty file == not written yet
      return JSON.parse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${path.basename(filePath)} exists but could not be read: ${lastErr.message}`);
}
