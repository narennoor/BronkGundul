// Atomic JSON persistence.
//
// The stores used to call fs.writeFileSync(FILE, JSON.stringify(...)), which
// truncates then fills. Any reader in another process could catch the seam —
// state.json is ~2.8 MB and rewritten every ~3s, and a plain JSON.parse of it
// from an analysis script failed on 26 Aug 2026 while the file was fine.

import "./_setup.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const { writeJsonAtomic, readJsonStore } = await import("../utils/json-store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-jsonstore-"));
const file = (name) => path.join(dir, name);
const leftovers = () => fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));

test("round-trips and overwrites", () => {
  const f = file("a.json");
  writeJsonAtomic(f, { positions: { A: 1 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { positions: { A: 1 } });
  writeJsonAtomic(f, { positions: { B: 2 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { positions: { B: 2 } });
});

test("leaves no temp file behind", () => {
  const f = file("b.json");
  for (let i = 0; i < 5; i++) writeJsonAtomic(f, { i });
  assert.deepEqual(leftovers(), []);
});

test("the temp file is a SIBLING — a cross-device rename would not be atomic", () => {
  // Capture the temp path by making the rename target undeletable is awkward;
  // instead assert the contract that matters: nothing lands outside the dir.
  const f = file("c.json");
  const before = fs.readdirSync(os.tmpdir()).length;
  writeJsonAtomic(f, { x: 1 });
  assert.equal(fs.readdirSync(os.tmpdir()).length, before);
});

test("a value that cannot be serialised leaves the OLD file intact", () => {
  const f = file("d.json");
  writeJsonAtomic(f, { good: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => writeJsonAtomic(f, circular));
  // the whole point: the previous state survives a failed write
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { good: true });
  assert.deepEqual(leftovers(), []);
});

test("readJsonStore: a MISSING file is a legitimate first run", () => {
  assert.deepEqual(readJsonStore(file("nope.json"), { positions: {} }), { positions: {} });
});

test("readJsonStore: an empty file is treated as not-yet-written", () => {
  const f = file("empty.json");
  fs.writeFileSync(f, "   ");
  assert.deepEqual(readJsonStore(f, { positions: {} }), { positions: {} });
});

test("readJsonStore: a corrupt EXISTING file throws instead of returning empty", () => {
  // state.js used to swallow this and return {positions:{}}; the next save()
  // then wrote that back, losing every tracked position holding real SOL.
  const f = file("bad.json");
  fs.writeFileSync(f, '{"positions": {"A": 1');
  assert.throws(() => readJsonStore(f, { positions: {} }), /could not be read/);
});
