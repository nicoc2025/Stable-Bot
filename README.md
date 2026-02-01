# Orca Whirlpools LP Range Manager

An off-chain automation bot that manages ONE Orca Whirlpools concentrated-liquidity position on Solana. The bot automatically recenters the LP range to maximize fee yield while avoiding unnecessary churn.

## Features

- **Automated Range Management**: Monitors price movements and rebalances when needed
- **Dwell Time Logic**: Prevents reacting to short price wicks
- **Anti-Thrashing Protection**: Enforces minimum time between rebalances
- **Edge Buffer Detection**: Optionally trigger before going out of range
- **Dry Run Mode**: Test strategy without executing transactions
- **Terminal Authentication**: Basic access control with bcrypt-hashed passwords
- **Non-Custodial**: Funds remain on Orca at all times

## Quick Start

### 1. Installation

```bash
# Install dependencies
yarn install

# Build TypeScript
yarn build
```

### 2. Configuration

```bash
# Copy example config
cp .env.example .env

# Edit .env with your settings
nano .env
```

**Required Configuration:**

```env
# Your wallet keypair (JSON file)
WALLET_KEYPAIR_PATH=~/.config/solana/id.json

# Orca Whirlpool address to manage
WHIRLPOOL_ADDRESS=<your-whirlpool-address>
```

### 3. First Run Setup

On first run, you'll be prompted to create authentication credentials:

```bash
yarn start

# Or run setup explicitly:
yarn start setup
```

### 4. Running the Bot

```bash
# Daemon mode (continuous monitoring)
yarn daemon

# Single evaluation
yarn once

# Check current status
yarn status
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `yarn daemon` | Run in continuous daemon mode |
| `yarn once` | Run single evaluation and exit |
| `yarn status` | Print current position status |
| `yarn start gen-keypair -o <path>` | Generate a new Solana keypair |
| `yarn start gen-password-hash` | Generate bcrypt hash for env var auth |
| `yarn start setup` | Run first-time credential setup |

## Configuration Options

### Network Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `CLUSTER` | Solana cluster (`mainnet-beta` or `devnet`) | `mainnet-beta` |
| `RPC_URL` | Solana RPC endpoint | Public endpoint |

### Strategy Parameters

| Variable | Description | Default |
|----------|-------------|---------|
| `RANGE_WIDTH_PERCENT` | Range width (0.10 = 10% each side) | `0.10` |
| `EDGE_BUFFER_PERCENT` | Trigger when within X% of edge (0 = disabled) | `0.02` |
| `DWELL_SECONDS` | Condition must hold this long before trigger | `10` |
| `MIN_REBALANCE_INTERVAL_SECONDS` | Minimum time between rebalances | `180` |
| `POLL_INTERVAL_SECONDS` | How often to check price | `5` |

### Operational Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `DRY_RUN` | If `true`, simulate without transactions | `true` |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `info` |

## Strategy Logic

### Trigger Conditions

1. **Out of Range**: Always triggers when price exits position bounds
2. **Near Edge** (if `EDGE_BUFFER_PERCENT > 0`): Triggers when price approaches boundary

### Dwell Time

- Trigger condition must remain **continuously true** for `DWELL_SECONDS`
- If condition breaks, timer resets
- Prevents reacting to short price spikes/wicks

### Anti-Thrashing

- Minimum `MIN_REBALANCE_INTERVAL_SECONDS` must pass between rebalances
- Prevents excessive transaction costs during volatile periods

### Rebalance Operation

When triggered:
1. Collect accrued fees and rewards
2. Remove all liquidity from old position
3. Close old position
4. Open new position centered on current price
5. Deposit available token balances

## Wallet Handling

### Using Existing Keypair

Point `WALLET_KEYPAIR_PATH` to your Solana CLI keypair:

```env
WALLET_KEYPAIR_PATH=~/.config/solana/id.json
```

### Generating New Keypair

```bash
yarn start gen-keypair -o ./my-bot-wallet.json
```

⚠️ **Security Warning**: 
- Keep your keypair file secure
- Never commit keypair files to git
- Back up your keypair in a secure location
- The bot has full signing authority over this wallet

## Safety Considerations

### Funds Safety

- **Non-custodial**: The bot only manages positions on Orca
- **No swaps**: Bot deposits whatever balances exist (may result in single-sided liquidity)
- **Graceful degradation**: If bot stops, position remains unchanged on Orca

### Risk Factors

1. **Impermanent Loss**: Concentrated liquidity amplifies IL
2. **Transaction Failures**: Network congestion may cause tx failures
3. **RPC Reliability**: Use dedicated RPC endpoints for production
4. **Price Volatility**: High volatility may cause frequent rebalances

### Recommended Practices

1. **Start with DRY_RUN=true** to validate strategy
2. **Use dedicated RPC** (Helius, QuickNode) for reliability
3. **Monitor logs** for unexpected behavior
4. **Start with small amounts** until comfortable
5. **Understand your Whirlpool's characteristics** (fee tier, typical volume)

## Running on VPS

### Systemd Service

Create `/etc/systemd/system/orca-lp-manager.service`:

```ini
[Unit]
Description=Orca LP Range Manager
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/orca-lp-manager
ExecStart=/usr/bin/node dist/index.js daemon
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable orca-lp-manager
sudo systemctl start orca-lp-manager
sudo systemctl status orca-lp-manager
```

### PM2 (Alternative)

```bash
pm2 start dist/index.js --name "orca-lp-manager" -- daemon
pm2 save
pm2 startup
```

### Logs

```bash
# Systemd
journalctl -u orca-lp-manager -f

# PM2
pm2 logs orca-lp-manager
```

## Troubleshooting

### "Keypair file not found"

Ensure `WALLET_KEYPAIR_PATH` points to a valid JSON keypair file:
```bash
ls -la ~/.config/solana/id.json
```

### "No position found"

- Verify `WHIRLPOOL_ADDRESS` is correct
- Ensure your wallet has an open position in that Whirlpool
- Check you're on the correct cluster (mainnet vs devnet)

### "Transaction failed"

- Check wallet has enough SOL for fees (~0.01 SOL recommended)
- Verify RPC endpoint is responsive
- Try increasing slippage tolerance (in orca.ts)

### Authentication Issues

Reset credentials by deleting the auth file:
```bash
rm ./data/auth.json
yarn start setup
```

## Architecture

```
src/
├── index.ts      # Entry point + CLI
├── config.ts     # Configuration schema & validation
├── auth.ts       # Terminal authentication (bcrypt)
├── orca.ts       # Whirlpool SDK interactions
├── strategy.ts   # Trigger logic (edge, dwell, cooldown)
├── rebalance.ts  # LP migration operations
└── logger.ts     # Structured logging
```

## License

MIT

## Disclaimer

This software is provided as-is. Use at your own risk. The authors are not responsible for any financial losses incurred from using this bot. Always understand the risks of providing liquidity and concentrated liquidity in particular before using automated tools.
