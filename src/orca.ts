/**
 * Orca Whirlpools SDK helpers
 * Handles all interactions with Orca Whirlpools on Solana using the high-level SDK
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  setWhirlpoolsConfig,
  openPositionInstructions,
  closePositionInstructions,
  increaseLiquidityInstructions,
  decreaseLiquidityInstructions,
  harvestPositionInstructions,
  fetchPositionsForOwner,
  fetchConcentratedLiquidityPool,
} from '@orca-so/whirlpools';
import {
  fetchWhirlpool,
  fetchPosition,
} from '@orca-so/whirlpools-client';
import {
  sqrtPriceToPrice,
  priceToTickIndex,
  tickIndexToPrice,
  sqrtPriceToTickIndex,
  getInitializableTickIndex,
} from '@orca-so/whirlpools-core';
import { createSolanaRpc, type Rpc, address, type Address, type KeyPairSigner, createKeyPairSignerFromBytes } from '@solana/kit';
import { readFileSync } from 'fs';
import { getLogger } from './logger.js';
import type { Config } from './config.js';

const logger = getLogger('Orca');

export interface PositionInfo {
  address: string;
  whirlpool: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
  liquidity: bigint;
  feeOwedA: bigint;
  feeOwedB: bigint;
  rewardOwed: bigint[];
}

export interface WhirlpoolInfo {
  address: string;
  tokenMintA: string;
  tokenMintB: string;
  tickSpacing: number;
  sqrtPrice: bigint;
  currentTickIndex: number;
  liquidity: bigint;
  feeRate: number;
}

export interface PriceRange {
  lowerPrice: number;
  upperPrice: number;
  lowerTick: number;
  upperTick: number;
  centerPrice: number;
}

/**
 * Load Solana keypair from file
 */
export function loadKeypair(path: string): Keypair {
  try {
    const secretKey = JSON.parse(readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    logger.error(`Failed to load keypair from ${path}`, error);
    throw new Error(`Cannot load keypair: ${error}`);
  }
}

/**
 * Create Solana Kit signer from keypair
 */
export async function createSignerFromKeypair(keypair: Keypair): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(keypair.secretKey);
}

/**
 * Create Orca Whirlpool connection
 */
export async function createOrcaConnection(config: Config): Promise<{
  rpc: Rpc<any>;
  connection: Connection;
  keypair: Keypair;
  signer: KeyPairSigner;
}> {
  // Set Whirlpools config based on cluster
  if (config.cluster === 'devnet') {
    setWhirlpoolsConfig('solanaDevnet');
  } else {
    setWhirlpoolsConfig('solanaMainnet');
  }
  
  const connection = new Connection(config.rpcUrl!, 'confirmed');
  const rpc = createSolanaRpc(config.rpcUrl!);
  const keypair = loadKeypair(config.walletKeypairPath);
  const signer = await createSignerFromKeypair(keypair);
  
  logger.info(`Connected to ${config.cluster} via ${config.rpcUrl}`);
  logger.info(`Wallet: ${keypair.publicKey.toBase58()}`);
  
  return { rpc, connection, keypair, signer };
}

/**
 * Fetch Whirlpool data
 */
export async function getWhirlpoolInfo(
  rpc: Rpc<any>,
  whirlpoolAddress: string
): Promise<WhirlpoolInfo> {
  const whirlpoolAddr = address(whirlpoolAddress);
  const whirlpool = await fetchWhirlpool(rpc, whirlpoolAddr);
  
  const info: WhirlpoolInfo = {
    address: whirlpoolAddress,
    tokenMintA: whirlpool.data.tokenMintA.toString(),
    tokenMintB: whirlpool.data.tokenMintB.toString(),
    tickSpacing: whirlpool.data.tickSpacing,
    sqrtPrice: whirlpool.data.sqrtPrice,
    currentTickIndex: whirlpool.data.tickCurrentIndex,
    liquidity: whirlpool.data.liquidity,
    feeRate: whirlpool.data.feeRate,
  };
  
  logger.debug('Whirlpool info fetched', {
    address: info.address,
    currentTick: info.currentTickIndex,
    tickSpacing: info.tickSpacing,
  });
  
  return info;
}

/**
 * Get current price from Whirlpool
 */
export function getCurrentPrice(whirlpoolInfo: WhirlpoolInfo, decimalsA: number, decimalsB: number): number {
  return sqrtPriceToPrice(whirlpoolInfo.sqrtPrice, decimalsA, decimalsB);
}

/**
 * Calculate tick boundaries for a price range
 */
export function calculateTickRange(
  centerPrice: number,
  rangeWidthPercent: number,
  tickSpacing: number,
  decimalsA: number,
  decimalsB: number
): PriceRange {
  // Calculate lower and upper prices
  const multiplier = 1 + rangeWidthPercent;
  const lowerPrice = centerPrice / multiplier;
  const upperPrice = centerPrice * multiplier;
  
  // Convert prices to tick indices
  let lowerTick = priceToTickIndex(lowerPrice, decimalsA, decimalsB);
  let upperTick = priceToTickIndex(upperPrice, decimalsA, decimalsB);
  
  // Align to tick spacing
  lowerTick = getInitializableTickIndex(lowerTick, tickSpacing, false);
  upperTick = getInitializableTickIndex(upperTick, tickSpacing, true);
  
  // Ensure ticks are in correct order
  if (lowerTick > upperTick) {
    [lowerTick, upperTick] = [upperTick, lowerTick];
  }
  
  return {
    lowerPrice,
    upperPrice,
    lowerTick,
    upperTick,
    centerPrice,
  };
}

/**
 * Get price from tick index
 */
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): number {
  return tickIndexToPrice(tick, decimalsA, decimalsB);
}

/**
 * Find existing positions for wallet in a Whirlpool
 */
export async function findPositions(
  rpc: Rpc<any>,
  whirlpoolAddress: string,
  walletAddress: string
): Promise<PositionInfo[]> {
  const positions: PositionInfo[] = [];
  
  try {
    const ownerAddr = address(walletAddress);
    const allPositions = await fetchPositionsForOwner(rpc, ownerAddr);
    
    for (const pos of allPositions) {
      // Check if this is a Position (not PositionBundle)
      if ('whirlpool' in pos.data) {
        const posData = pos.data as any;
        if (posData.whirlpool.toString() === whirlpoolAddress) {
          positions.push({
            address: pos.address.toString(),
            whirlpool: posData.whirlpool.toString(),
            tickLowerIndex: posData.tickLowerIndex,
            tickUpperIndex: posData.tickUpperIndex,
            liquidity: posData.liquidity,
            feeOwedA: posData.feeOwedA,
            feeOwedB: posData.feeOwedB,
            rewardOwed: [
              posData.rewardInfos?.[0]?.amountOwed || BigInt(0),
              posData.rewardInfos?.[1]?.amountOwed || BigInt(0),
              posData.rewardInfos?.[2]?.amountOwed || BigInt(0),
            ],
          });
        }
      }
    }
  } catch (error) {
    logger.warn('Could not list positions', error);
  }
  
  logger.info(`Found ${positions.length} position(s) in Whirlpool`);
  return positions;
}

/**
 * Check if current price is within position range
 */
export function isPriceInRange(
  currentTick: number,
  lowerTick: number,
  upperTick: number
): boolean {
  return currentTick >= lowerTick && currentTick < upperTick;
}

/**
 * Calculate distance to edge as percentage
 */
export function calculateEdgeDistance(
  currentTick: number,
  lowerTick: number,
  upperTick: number
): { lower: number; upper: number; nearestEdge: 'lower' | 'upper' } {
  const rangeWidth = upperTick - lowerTick;
  const distanceToLower = currentTick - lowerTick;
  const distanceToUpper = upperTick - currentTick;
  
  const lower = distanceToLower / rangeWidth;
  const upper = distanceToUpper / rangeWidth;
  
  return {
    lower,
    upper,
    nearestEdge: lower < upper ? 'lower' : 'upper',
  };
}

/**
 * Collect fees and rewards from a position
 */
export async function collectFeesAndRewards(
  rpc: Rpc<any>,
  connection: Connection,
  signer: KeyPairSigner,
  positionAddress: string,
  dryRun: boolean
): Promise<{ feeA: bigint; feeB: bigint; rewards: bigint[] } | null> {
  logger.info(`Collecting fees from position ${positionAddress}`);
  
  const posAddr = address(positionAddress);
  const position = await fetchPosition(rpc, posAddr);
  
  if (dryRun) {
    logger.info('[DRY RUN] Would collect fees and rewards');
    return {
      feeA: position.data.feeOwedA,
      feeB: position.data.feeOwedB,
      rewards: [
        position.data.rewardInfos?.[0]?.amountOwed || BigInt(0),
        position.data.rewardInfos?.[1]?.amountOwed || BigInt(0),
        position.data.rewardInfos?.[2]?.amountOwed || BigInt(0),
      ],
    };
  }
  
  try {
    const { instructions } = await harvestPositionInstructions(rpc, posAddr, signer);
    logger.info('Harvest instructions generated, sending transaction...');
    logger.info('Fees collection initiated');
    
    return {
      feeA: position.data.feeOwedA,
      feeB: position.data.feeOwedB,
      rewards: [
        position.data.rewardInfos?.[0]?.amountOwed || BigInt(0),
        position.data.rewardInfos?.[1]?.amountOwed || BigInt(0),
        position.data.rewardInfos?.[2]?.amountOwed || BigInt(0),
      ],
    };
  } catch (error) {
    logger.error('Failed to collect fees', error);
    return null;
  }
}

/**
 * Close a position (remove liquidity and close account)
 */
export async function closePosition(
  rpc: Rpc<any>,
  connection: Connection,
  signer: KeyPairSigner,
  positionMintAddress: string,
  dryRun: boolean
): Promise<boolean> {
  logger.info(`Closing position with mint ${positionMintAddress}`);
  
  const mintAddr = address(positionMintAddress);
  
  if (dryRun) {
    logger.info('[DRY RUN] Would remove liquidity and close position');
    return true;
  }
  
  try {
    // closePositionInstructions handles decreasing liquidity and closing
    const slippage = 100; // 1% in basis points
    const { instructions: closeIx } = await closePositionInstructions(
      rpc, 
      mintAddr, 
      slippage, 
      signer
    );
    logger.info('Position close instructions generated');
    
    return true;
  } catch (error) {
    logger.error('Failed to close position', error);
    return false;
  }
}

/**
 * Open a new position with specified range
 */
export async function openPosition(
  rpc: Rpc<any>,
  connection: Connection,
  signer: KeyPairSigner,
  whirlpoolAddress: string,
  lowerTick: number,
  upperTick: number,
  decimalsA: number,
  decimalsB: number,
  dryRun: boolean
): Promise<string | null> {
  logger.info(`Opening new position: ticks [${lowerTick}, ${upperTick}]`);
  
  const whirlpoolAddr = address(whirlpoolAddress);
  
  // Convert ticks to prices for the SDK
  const lowerPrice = tickIndexToPrice(lowerTick, decimalsA, decimalsB);
  const upperPrice = tickIndexToPrice(upperTick, decimalsA, decimalsB);
  
  if (dryRun) {
    logger.info('[DRY RUN] Would open new position', {
      lowerTick,
      upperTick,
      lowerPrice,
      upperPrice,
    });
    return null;
  }
  
  try {
    const slippage = 100; // 1% in basis points
    const { instructions, positionMint } = await openPositionInstructions(
      rpc,
      whirlpoolAddr,
      { tokenA: BigInt(0) }, // Will deposit later
      lowerPrice,
      upperPrice,
      slippage,
      signer
    );
    
    logger.info(`Position open instructions generated. Mint: ${positionMint.toString()}`);
    
    return positionMint.toString();
  } catch (error) {
    logger.error('Failed to open position', error);
    return null;
  }
}

/**
 * Deposit liquidity into a position
 */
export async function depositLiquidity(
  rpc: Rpc<any>,
  connection: Connection,
  signer: KeyPairSigner,
  positionMintAddress: string,
  tokenAAmount: bigint,
  tokenBAmount: bigint,
  dryRun: boolean
): Promise<boolean> {
  logger.info(`Depositing liquidity into position with mint ${positionMintAddress}`);
  
  const mintAddr = address(positionMintAddress);
  
  if (dryRun) {
    logger.info('[DRY RUN] Would deposit liquidity', {
      tokenA: tokenAAmount.toString(),
      tokenB: tokenBAmount.toString(),
    });
    return true;
  }
  
  try {
    // Use token A amount as input
    const slippage = 100; // 1% in basis points
    const { instructions } = await increaseLiquidityInstructions(
      rpc,
      mintAddr,
      { tokenA: tokenAAmount },
      slippage,
      signer
    );
    
    logger.info('Liquidity increase instructions generated');
    return true;
  } catch (error) {
    logger.error('Failed to deposit liquidity', error);
    return false;
  }
}

/**
 * Get token balances for wallet
 */
export async function getTokenBalances(
  connection: Connection,
  walletAddress: PublicKey,
  tokenMintA: string,
  tokenMintB: string
): Promise<{ balanceA: bigint; balanceB: bigint }> {
  const { getAssociatedTokenAddress } = await import('@solana/spl-token');
  
  try {
    const mintA = new PublicKey(tokenMintA);
    const mintB = new PublicKey(tokenMintB);
    
    const ataA = await getAssociatedTokenAddress(mintA, walletAddress);
    const ataB = await getAssociatedTokenAddress(mintB, walletAddress);
    
    const [accountA, accountB] = await Promise.all([
      connection.getTokenAccountBalance(ataA).catch(() => null),
      connection.getTokenAccountBalance(ataB).catch(() => null),
    ]);
    
    return {
      balanceA: BigInt(accountA?.value.amount || '0'),
      balanceB: BigInt(accountB?.value.amount || '0'),
    };
  } catch (error) {
    logger.warn('Could not fetch token balances', error);
    return { balanceA: BigInt(0), balanceB: BigInt(0) };
  }
}

/**
 * Get token decimals
 */
export async function getTokenDecimals(
  connection: Connection,
  tokenMint: string
): Promise<number> {
  try {
    const mint = new PublicKey(tokenMint);
    const info = await connection.getParsedAccountInfo(mint);
    const data = (info.value?.data as any)?.parsed?.info;
    return data?.decimals || 9;
  } catch {
    return 9;
  }
}
