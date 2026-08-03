# CopetGundul

**Autonomous Meteora DLMM liquidity agent for Solana, powered by LLMs.**

> **Upstream attribution** — this repository is developed from
> [yunus-0x/meridian](https://github.com/yunus-0x/meridian) (Meridian) as its
> upstream source. CopetGundul is a hardened, personally-operated fork that adds
> local instrumentation (PnL reconciliation, screening-funnel stats, exit-slippage
> tracking), extra safety rules, and ops tooling on top of the original agent.

CopetGundul runs continuous screening and management cycles: it scans Meteora
DLMM pools against configurable thresholds, deploys SOL into the best candidate,
monitors open positions (PnL, fees, range), and closes them via deterministic
exit rules — stop loss, trailing take-profit, out-of-range wait, low yield, and
max hold. It learns from every closed position and evolves its own thresholds.

## Features

- **Autonomous screening** — hard filters (TVL, fee/TVL, organic score, holders, mcap, bin step, launchpad, cooldowns) plus LLM-driven final selection
- **Autonomous management** — deterministic exit rules in JS; the LLM is only invoked for the hard cases
- **Learning loop** — per-pool memory, lesson store, Darwinian signal weighting, threshold evolution, and shared learning via HiveMind
- **Ops surface** — Telegram bot (commands, live cycle reports, settings menu), interactive REPL, one-shot CLI, and Claude Code slash commands
- **Signal sources** — optional Discord listener, GMGN/Jupiter trending, DexScreener boosts

## Requirements

- Node.js 22+
- Solana wallet (base58 private key) + RPC endpoint ([Helius](https://helius.xyz) recommended)
- [OpenRouter](https://openrouter.ai) API key (or any OpenAI-compatible endpoint)
- Telegram bot token (optional)

## Quick start

```bash
git clone https://github.com/narennoor/CopetGundul
cd CopetGundul
npm install
npm run setup        # interactive wizard — writes .env + user-config.json
```

Then run:

```bash
npm run dev          # dry run — no on-chain transactions
npm start            # live mode (REPL + cron + Telegram)
```

For VPS / always-on operation, use PM2 via the ecosystem file:

```bash
npm run pm2:start    # do NOT use "pm2 start index.js" directly
pm2 save
```

After changing `.env`, config, or code: `npm run pm2:restart`.

> Secrets (`WALLET_PRIVATE_KEY`, API keys, Telegram token) go in `.env` only —
> never in `user-config.json`. Both files are gitignored. An optional encrypted
> `.env` flow is available via `npm run env:encrypt`.

## Interfaces

| Surface | How |
|---|---|
| Autonomous daemon | `npm start` — screening + management cycles on cron, with a live-countdown REPL |
| Telegram | `/status`, `/positions`, `/close <n>`, `/screen`, `/candidates`, `/deploy <n>`, `/settings`, `/briefing`, free-form chat |
| CLI | `node cli.js <command>` — every tool as a subcommand with JSON output (`positions`, `candidates`, `deploy`, `close`, `swap`, `lessons`, `evolve`, …) |
| Claude Code | `/screen`, `/manage`, `/balance`, `/positions`, `/candidates`, `/pool-compare`, plus `screener` / `manager` sub-agents |

## Configuration

All tunables live in `user-config.json` (see
[user-config.example.json](user-config.example.json) for the full commented
set): screening thresholds, position sizing, exit rules, trailing TP, cycle
intervals, per-role LLM models, and trading-hours windows. Change values at
runtime with `node cli.js config set <key> <value>` or the Telegram `/settings`
menu.

The engineering manual — architecture, agent roles, safety invariants, state
files, and how to extend the agent — is in [CLAUDE.md](CLAUDE.md).

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous
trading agent carries real financial risk — you can lose funds. Always start
with `DRY_RUN=true`, and never deploy more capital than you can afford to lose.
This is not financial advice, and the authors are not responsible for any
losses incurred through use of this software.
