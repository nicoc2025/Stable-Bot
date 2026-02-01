/**
 * Configuration module for Orca LP Range Manager
 * Uses Zod for schema validation
 */

import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getLogger, type LogLevel } from './logger.js';

// Load .env file
loadDotenv();

const logger = getLogger('Config');

// Configuration schema with validation
const ConfigSchema = z.object({
  // Network
  cluster: z.enum(['mainnet-beta', 'devnet']).default('mainnet-beta'),
  rpcUrl: z.string().url().optional(),
  
  // Wallet
  walletKeypairPath: z.string().min(1, 'WALLET_KEYPAIR_PATH is required'),
  
  // Whirlpool
  whirlpoolAddress: z.string().min(32, 'WHIRLPOOL_ADDRESS is required'),
  
  // Strategy parameters
  rangeWidthPercent: z.number().min(0.001).max(1).default(0.10),
  edgeBufferPercent: z.number().min(0).max(0.5).default(0.02),
  dwellSeconds: z.number().int().min(0).default(10),
  minRebalanceIntervalSeconds: z.number().int().min(0).default(180),
  pollIntervalSeconds: z.number().int().min(1).max(60).default(5),
  
  // Operational
  dryRun: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Auth (optional, can be set via first-run setup)
  authUsername: z.string().optional(),
  authPasswordHash: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

// RPC endpoints by cluster
const DEFAULT_RPC_URLS: Record<string, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  'devnet': 'https://api.devnet.solana.com',
};

// Whirlpool program IDs by cluster
export const WHIRLPOOL_PROGRAM_IDS: Record<string, string> = {
  'mainnet-beta': 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'devnet': 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
};

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return p.replace('~', home);
  }
  return resolve(p);
}

export function loadConfig(): Config {
  const rawConfig = {
    cluster: process.env.CLUSTER || 'mainnet-beta',
    rpcUrl: process.env.RPC_URL,
    walletKeypairPath: process.env.WALLET_KEYPAIR_PATH || '',
    whirlpoolAddress: process.env.WHIRLPOOL_ADDRESS || '',
    rangeWidthPercent: parseNumber(process.env.RANGE_WIDTH_PERCENT),
    edgeBufferPercent: parseNumber(process.env.EDGE_BUFFER_PERCENT),
    dwellSeconds: parseNumber(process.env.DWELL_SECONDS),
    minRebalanceIntervalSeconds: parseNumber(process.env.MIN_REBALANCE_INTERVAL_SECONDS),
    pollIntervalSeconds: parseNumber(process.env.POLL_INTERVAL_SECONDS),
    dryRun: parseBoolean(process.env.DRY_RUN),
    logLevel: process.env.LOG_LEVEL as LogLevel | undefined,
    authUsername: process.env.AUTH_USERNAME,
    authPasswordHash: process.env.AUTH_PASSWORD_HASH,
  };

  try {
    const config = ConfigSchema.parse(rawConfig);
    
    // Expand keypair path
    config.walletKeypairPath = expandPath(config.walletKeypairPath);
    
    // Set default RPC URL based on cluster if not provided
    if (!config.rpcUrl) {
      config.rpcUrl = DEFAULT_RPC_URLS[config.cluster];
    }
    
    // Validate keypair file exists
    if (!existsSync(config.walletKeypairPath)) {
      throw new Error(`Keypair file not found: ${config.walletKeypairPath}`);
    }
    
    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Configuration validation failed:', error.errors);
      throw new Error(`Invalid configuration: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw error;
  }
}

export function validateConfig(config: Config): void {
  // Additional runtime validations
  if (config.edgeBufferPercent >= config.rangeWidthPercent) {
    throw new Error('EDGE_BUFFER_PERCENT must be less than RANGE_WIDTH_PERCENT');
  }
  
  if (config.dwellSeconds > config.minRebalanceIntervalSeconds && config.minRebalanceIntervalSeconds > 0) {
    logger.warn('DWELL_SECONDS is greater than MIN_REBALANCE_INTERVAL_SECONDS - this may cause unexpected behavior');
  }
}

export function printConfig(config: Config): void {
  const masked = {
    ...config,
    walletKeypairPath: config.walletKeypairPath.replace(/^.*\//, '****/'),
    authPasswordHash: config.authPasswordHash ? '********' : undefined,
  };
  
  console.log('\n=== Configuration ===');
  console.log(JSON.stringify(masked, null, 2));
  console.log('====================\n');
}

export function getWhirlpoolProgramId(cluster: string): string {
  return WHIRLPOOL_PROGRAM_IDS[cluster] || WHIRLPOOL_PROGRAM_IDS['mainnet-beta'];
}
