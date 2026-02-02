#!/usr/bin/env node
/**
 * Orca LP Range Manager - Entry Point
 * Off-chain automation bot for managing Orca Whirlpools concentrated liquidity positions
 */

import { Command } from 'commander';
import { Keypair, PublicKey } from '@solana/web3.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getLogger, type LogLevel } from './logger.js';
import { loadConfig, validateConfig, printConfig, type Config } from './config.js';
import { hasCredentials, setupCredentials, authenticate, generatePasswordHash } from './auth.js';
import {
  createOrcaClient,
  getWhirlpoolInfo,
  findPositions,
  getTokenDecimals,
} from './orca.js';
import {
  createStrategyState,
  runStrategyEvaluation,
  formatPositionStatus,
  type StrategyState,
  type StrategyParams,
} from './strategy.js';
import {
  executeRebalance,
  printRebalancePreview,
} from './rebalance.js';
import { getSolPriceUsd } from './price.js';
import BN from 'bn.js';

const logger = getLogger('Main');

// Session statistics (reset on each bot start)
interface SessionStats {
  startTime: number;
  rebalanceCount: number;
  totalFeeA: BN;        // Raw token units (Token A - e.g., USD1)
  totalFeeB: BN;        // Raw token units (Token B - e.g., USDC)
  totalSolCostLamports: number;
}

const sessionStats: SessionStats = {
  startTime: Date.now(),
  rebalanceCount: 0,
  totalFeeA: new BN(0),
  totalFeeB: new BN(0),
  totalSolCostLamports: 0,
};

// Store connection and wallet for balance checks
let globalConnection: any = null;
let globalWalletPublicKey: any = null;

const program = new Command();

program
  .name('orca-lp-manager')
  .description('Off-chain Orca Whirlpools LP Range Manager')
  .version('1.0.0');

program
  .command('daemon')
  .description('Run in continuous daemon mode')
  .action(async () => {
    await runDaemon();
  });

program
  .command('once')
  .description('Run single evaluation and exit')
  .action(async () => {
    await runOnce();
  });

program
  .command('status')
  .description('Print current position status and exit')
  .action(async () => {
    await printStatus();
  });

program
  .command('gen-keypair')
  .description('Generate a new Solana keypair')
  .option('-o, --output <path>', 'Output path for keypair file', './keypair.json')
  .action(async (options) => {
    await generateKeypair(options.output);
  });

program
  .command('gen-password-hash')
  .description('Generate bcrypt hash for password (for env var)')
  .action(async () => {
    await generatePasswordHash();
  });

program
  .command('setup')
  .description('Run first-time setup (create credentials)')
  .action(async () => {
    await setupCredentials();
  });

// Default command (daemon)
program.action(async () => {
  await runDaemon();
});

/**
 * Initialize application - load config, authenticate, etc.
 */
async function initialize(): Promise<Config> {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║       ORCA WHIRLPOOLS LP RANGE MANAGER v1.0.0             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  // Load and validate config
  let config: Config;
  try {
    config = loadConfig();
    validateConfig(config);
  } catch (error) {
    logger.error('Configuration error', error);
    console.error('\n⚠️  Please check your .env file or environment variables.');
    console.error('   Copy .env.example to .env and fill in required values.\n');
    process.exit(1);
  }
  
  // Set log level
  logger.setLevel(config.logLevel as LogLevel);
  
  // Check and setup authentication
  if (!hasCredentials(config.authUsername, config.authPasswordHash)) {
    console.log('No credentials found. Running first-time setup...\n');
    await setupCredentials();
  }
  
  // Authenticate
  const authenticated = await authenticate(config.authUsername, config.authPasswordHash);
  if (!authenticated) {
    console.error('\n⚠️  Authentication failed. Exiting.\n');
    process.exit(1);
  }
  
  // Print config (masked)
  printConfig(config);
  
  return config;
}

/**
 * Run daemon mode - continuous polling and evaluation
 */
async function runDaemon(): Promise<void> {
  const config = await initialize();
  
  logger.info('Starting daemon mode...');
  logger.info(`Poll interval: ${config.pollIntervalSeconds}s`);
  logger.info(`Dry run: ${config.dryRun}`);
  
  const { ctx, client, wallet, connection } = await createOrcaClient(config);
  
  // Store for balance checks in stats
  globalConnection = connection;
  globalWalletPublicKey = wallet.publicKey;
  
  let state = createStrategyState();
  let decimalsA = 9; // Will be updated
  let decimalsB = 6; // Will be updated
  
  // Get token decimals once
  try {
    const whirlpoolInfo = await getWhirlpoolInfo(client, config.whirlpoolAddress);
    decimalsA = await getTokenDecimals(connection, whirlpoolInfo.tokenMintA);
    decimalsB = await getTokenDecimals(connection, whirlpoolInfo.tokenMintB);
    logger.debug(`Token decimals: A=${decimalsA}, B=${decimalsB}`);
  } catch (error) {
    logger.warn('Could not fetch token decimals, using defaults', error);
  }
  
  const params: StrategyParams = {
    rangeWidthPercent: config.rangeWidthPercent,
    edgeBufferPercent: config.edgeBufferPercent,
    dwellSeconds: config.dwellSeconds,
    minRebalanceIntervalSeconds: config.minRebalanceIntervalSeconds,
  };
  
  console.log('\n🔄 Daemon started. Press Ctrl+C to stop.\n');
  
  // Main loop
  while (true) {
    try {
      // Fetch current state
      const whirlpoolInfo = await getWhirlpoolInfo(client, config.whirlpoolAddress);
      const positions = await findPositions(ctx, client, config.whirlpoolAddress, wallet.publicKey);
      
      if (positions.length === 0) {
        logger.warn('No position found in Whirlpool. Waiting for position...');
        await sleep(config.pollIntervalSeconds * 1000);
        continue;
      }
      
      // Use first position (we manage ONE position per config)
      const position = positions[0];
      
      // Run strategy evaluation
      const evaluation = runStrategyEvaluation(
        state,
        whirlpoolInfo,
        position,
        params,
        decimalsA,
        decimalsB
      );
      
      state = evaluation.newState;
      
      if (evaluation.shouldRebalance) {
        logger.info(`Rebalance triggered: ${evaluation.reason}`);
        
        // Show preview
        await printRebalancePreview(position, whirlpoolInfo, config, decimalsA, decimalsB);
        
        // Execute rebalance
        const { result, newState } = await executeRebalance(
          config,
          state,
          position,
          whirlpoolInfo,
          decimalsA,
          decimalsB
        );
        
        state = newState;
        
        if (result.success) {
          logger.info('Rebalance completed successfully');
        } else {
          logger.error('Rebalance failed', result.error);
        }
      } else {
        logger.debug(`No rebalance needed. Reason: ${evaluation.reason || 'in range'}`);
      }
      
    } catch (error) {
      logger.error('Error in daemon loop', error);
    }
    
    await sleep(config.pollIntervalSeconds * 1000);
  }
}

/**
 * Run single evaluation
 */
async function runOnce(): Promise<void> {
  const config = await initialize();
  
  logger.info('Running single evaluation...');
  
  const { ctx, client, wallet, connection } = await createOrcaClient(config);
  
  // Get token decimals
  const whirlpoolInfo = await getWhirlpoolInfo(client, config.whirlpoolAddress);
  const decimalsA = await getTokenDecimals(connection, whirlpoolInfo.tokenMintA);
  const decimalsB = await getTokenDecimals(connection, whirlpoolInfo.tokenMintB);
  
  // Find positions
  const positions = await findPositions(ctx, client, config.whirlpoolAddress, wallet.publicKey);
  
  if (positions.length === 0) {
    console.log('\n⚠️  No position found in specified Whirlpool.\n');
    return;
  }
  
  const position = positions[0];
  const state = createStrategyState();
  
  const params: StrategyParams = {
    rangeWidthPercent: config.rangeWidthPercent,
    edgeBufferPercent: config.edgeBufferPercent,
    dwellSeconds: config.dwellSeconds,
    minRebalanceIntervalSeconds: config.minRebalanceIntervalSeconds,
  };
  
  // Evaluate
  const evaluation = runStrategyEvaluation(
    state,
    whirlpoolInfo,
    position,
    params,
    decimalsA,
    decimalsB
  );
  
  // Print status
  console.log(formatPositionStatus(whirlpoolInfo, position, decimalsA, decimalsB));
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                   EVALUATION RESULT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Should Rebalance: ${evaluation.shouldRebalance ? 'YES' : 'NO'}`);
  console.log(`  Trigger Reason: ${evaluation.reason}`);
  console.log(`  Current Price: ${evaluation.details.currentPrice.toFixed(6)}`);
  console.log(`  Current Tick: ${evaluation.details.currentTick}`);
  if (evaluation.details.edgeDistance) {
    console.log(`  Distance to Lower: ${(evaluation.details.edgeDistance.lower * 100).toFixed(2)}%`);
    console.log(`  Distance to Upper: ${(evaluation.details.edgeDistance.upper * 100).toFixed(2)}%`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');
  
  if (evaluation.shouldRebalance) {
    await printRebalancePreview(position, whirlpoolInfo, config, decimalsA, decimalsB);
    
    if (!config.dryRun) {
      console.log('⚠️  Rebalance would execute in LIVE mode. Currently in DRY_RUN=false.');
      console.log('   Set DRY_RUN=true to test without executing transactions.\n');
    }
  }
}

/**
 * Print current status
 */
async function printStatus(): Promise<void> {
  const config = await initialize();
  
  const { ctx, client, wallet, connection } = await createOrcaClient(config);
  
  // Fetch data
  const whirlpoolInfo = await getWhirlpoolInfo(client, config.whirlpoolAddress);
  const decimalsA = await getTokenDecimals(connection, whirlpoolInfo.tokenMintA);
  const decimalsB = await getTokenDecimals(connection, whirlpoolInfo.tokenMintB);
  
  const positions = await findPositions(ctx, client, config.whirlpoolAddress, wallet.publicKey);
  const position = positions.length > 0 ? positions[0] : null;
  
  console.log(formatPositionStatus(whirlpoolInfo, position, decimalsA, decimalsB));
}

/**
 * Generate a new Solana keypair
 */
async function generateKeypair(outputPath: string): Promise<void> {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                 GENERATE KEYPAIR');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const keypair = Keypair.generate();
  const secretKey = Array.from(keypair.secretKey);
  
  // Ensure directory exists
  const dir = dirname(outputPath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  // Write keypair
  writeFileSync(outputPath, JSON.stringify(secretKey), { mode: 0o600 });
  
  console.log(`  ✓ Keypair generated successfully!`);
  console.log(`  Public Key: ${keypair.publicKey.toBase58()}`);
  console.log(`  Saved to: ${outputPath}`);
  console.log(`\n  ⚠️  IMPORTANT: Keep this file secure and back it up!`);
  console.log(`      Never share your secret key.\n`);
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down gracefully...\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 Received SIGTERM, shutting down...\n');
  process.exit(0);
});

// Run CLI
program.parse();
