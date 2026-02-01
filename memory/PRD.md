# Orca Whirlpools LP Range Manager - PRD

## Original Problem Statement
Build a terminal-based, off-chain automation bot that manages ONE Orca Whirlpools concentrated-liquidity position on Solana. The bot automatically recenters the LP range to maximize fee yield while avoiding unnecessary churn. NO UI in v1 - Terminal only.

## Architecture
- **Runtime**: Node.js + TypeScript (ESM)
- **CLI Framework**: Commander.js
- **Solana SDK**: @orca-so/whirlpools-sdk v0.18.0, @solana/web3.js
- **Authentication**: bcrypt for password hashing
- **Config**: dotenv + Zod schema validation

## User Personas
1. **DeFi Yield Farmer** - Wants automated LP management on Orca
2. **Solana Developer** - Technical user comfortable with terminal tools
3. **VPS Operator** - Runs bot on remote server for 24/7 operation

## Core Requirements (Static)
- Manage exactly ONE LP position per configuration
- Symmetric (50/50) range around current price
- Configurable via .env or environment variables
- Dwell time logic to avoid reacting to wicks
- Anti-thrashing cooldown between rebalances
- Non-custodial (funds remain on Orca)
- Basic terminal authentication (bcrypt)

## What's Been Implemented (v1.0.0)
- [x] Complete TypeScript project structure
- [x] CLI commands: daemon, once, status, gen-keypair, gen-password-hash, setup
- [x] Configuration validation with Zod schema
- [x] bcrypt authentication with first-run setup flow
- [x] Orca Whirlpools SDK integration
- [x] Strategy logic: edge detection, dwell time, anti-thrashing
- [x] Rebalance operations: collect fees → close position → open new → deposit
- [x] Structured logging
- [x] Comprehensive README documentation

## Prioritized Backlog

### P0 - Critical (Blocking)
- None - MVP complete

### P1 - High Priority
- [ ] Transaction execution and signing (currently generates instructions but needs sendAndConfirmTransaction)
- [ ] Position bundle support for Token-2022
- [ ] Better error handling for RPC failures

### P2 - Medium Priority
- [ ] Telegram/Discord notifications on rebalance
- [ ] Historical rebalance logging to file
- [ ] Multiple whirlpool support (config array)

### P3 - Nice to Have
- [ ] Web dashboard for monitoring (future v2)
- [ ] Auto-swap to balance token ratios before deposit
- [ ] Backtesting simulation mode

## Next Tasks
1. Test with real Solana mainnet position (DRY_RUN=true first)
2. Add transaction execution flow for live rebalancing
3. Implement error retry logic for RPC failures
4. Add Telegram notifications for rebalance events

## Configuration Reference
| Variable | Description | Default |
|----------|-------------|---------|
| WALLET_KEYPAIR_PATH | Path to Solana keypair JSON | Required |
| WHIRLPOOL_ADDRESS | Orca Whirlpool to manage | Required |
| RANGE_WIDTH_PERCENT | Position range width (0.10 = 10%) | 0.10 |
| EDGE_BUFFER_PERCENT | Near-edge trigger threshold | 0.02 |
| DWELL_SECONDS | Time condition must hold | 10 |
| MIN_REBALANCE_INTERVAL_SECONDS | Cooldown between rebalances | 180 |
| POLL_INTERVAL_SECONDS | How often to check price | 5 |
| DRY_RUN | Simulate without transactions | true |
| LOG_LEVEL | debug/info/warn/error | info |

---
Last Updated: 2026-01-01
