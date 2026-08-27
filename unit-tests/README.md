# unit-tests/

Offline unit tests. **Not** `test/` — that directory holds live integration tests
that hit the real LLM, the real wallet, and the shared `state.json`, and must
never be run while a daemon is up.

Everything here runs fully isolated from the live data files:

- no RPC, no LLM, no network at all
- no on-chain transaction is ever built against a real signer
- every test file's **first import is `./_setup.mjs`**, which points
  `MERIDIAN_STATE_DIR` at a fresh temp directory before any production module
  loads. All `repoPath()` consumers (`state.js`, `lessons.js`, `pool-memory.js`,
  `signal-weights.js`, `config.js`, `logger.js`, …) read and write there, so the
  live `state.json` & friends are **never opened** — the suite is safe to run
  while the daemon is up. (The old byte-snapshot/restore of the real files raced
  the daemon's load+save loop — 18 Aug 2026: 22 phantom UNITTEST positions
  leaked into production `state.json`.)
- `_setup.mjs` refuses to run if `MERIDIAN_STATE_DIR` is pointed at the repo
  root, so the suite cannot be aimed back at the live files even deliberately.
- the auto-created temp dir is removed on process exit; pre-set
  `MERIDIAN_STATE_DIR` to a scratch path yourself to inspect what a run writes.

When adding a new test file, keep `import "./_setup.mjs";` as the **first**
import — isolation only holds if the env var is set before `repo-root.js` (or
anything importing it) is evaluated.

Run:

```bash
npm run test:unit
```

`--test-concurrency=1` is deliberate: the suite is timing-sensitive (trailing
recheck windows) and parallel files would contend for CPU. Each file already
gets its own state dir, so there is no file-level race either way.

| File | Covers |
|---|---|
| `sendtx.test.mjs` | `sendTx()` — compute-budget injection, rebroadcast loop, signature retention on confirm timeout, `getSignatureStatus` rescue (era #9 task 1) |
| `close-cash.test.mjs` | close-signature accumulation across attempts + the Meteora cross-check arithmetic (era #9 task 2) |
| `trailing.test.mjs` | trailing tick trace, overshoot fields, breakeven floor (era #9 task 3) |
| `sync-close.test.mjs` | sync auto-close bookkeeping — snapshot return, pending-cash performance record, no double-booking (12 Aug 2026 incident) |
| `recheck-suspect.test.mjs` | `isCashSuspect()` — the default recheck-cash filter, rent-refund allowance |
| `hard-tp.test.mjs` | `hardTakeProfitPct` ceiling fast-path (era #10 GUNICORN incident) |
| `pnl-cutoff.test.mjs` | `/pnl` reporting cutoff — `resolveReportCutoff`/`applyCutoff`, `classifyCashFlows` classification, report rendering |
| `financial-yearly.test.mjs` | fase-3 — year seal + assertion 10 on a hand-computed 12-month dataset (incl. a tampered month seal labeling, never throwing), YTD composition (closed-month seals + running-month fold, §04 fold rules, sigma lane check), the 1 Januari ordering (year path seals a leftover December first), mid-year-ledger YTD labels, zero-network guard |
| `financial-report.test.mjs` | fase-2 seals & reports — seal chain per kind (test d), immutable seal / explicit reseal (test e), assertions 1–7 as labels, missing-window & missing-endpoint behavior, §06 formatting, and a fetch stub that throws: the whole seal/report path is zero-network |
| `equity-snapshot.test.mjs` | daily equity ledger — zero-walk rule (test a), signed-bridge identity (test g), window assignment + overlap sig dedup, late-indexed tx conservation, integrity drift, idempotency, derived backfill, `healGap`. Uses `MERIDIAN_LEDGER_DIR` (set by `_setup.mjs`) because the ledger bypasses `repoPath()` |
