# unit-tests/

Offline unit tests. **Not** `test/` — that directory holds live integration tests
that hit the real LLM, the real wallet, and the shared `state.json`, and must
never be run while a daemon is up.

Everything here runs against mocks or a backed-up copy of the state file:

- no RPC, no LLM, no network at all
- no on-chain transaction is ever built against a real signer
- `state.json` is byte-restored in a `finally`, so a crashed run cannot leave
  the file dirty

Run:

```bash
npm run test:unit
```

`--test-concurrency=1` is deliberate: two files that both stub positions into
`state.json` would race if they ran in parallel processes.

| File | Covers |
|---|---|
| `sendtx.test.mjs` | `sendTx()` — compute-budget injection, rebroadcast loop, signature retention on confirm timeout, `getSignatureStatus` rescue (era #9 task 1) |
| `close-cash.test.mjs` | close-signature accumulation across attempts + the Meteora cross-check arithmetic (era #9 task 2) |
| `trailing.test.mjs` | trailing tick trace, overshoot fields, breakeven floor (era #9 task 3) |
