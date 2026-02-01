/**
 * Orca Whirlpools SDK helpers
 * Handles all interactions with Orca Whirlpools on Solana using the legacy SDK
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  WhirlpoolContext,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  buildWhirlpoolClient,
  PDAUtil,
  PriceMath,
  increaseLiquidityQuoteByInputToken,
  decreaseLiquidityQuoteByLiquidity,
  IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import { getLogger } from './logger.js';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import type { Config } from './config.js';

const logger = getLogger('Orca');

export interface PositionInfo {
  address: PublicKey;
  positionMint: PublicKey;
  whirlpool: PublicKey;
  tickLowerIndex: number;
  tickUpperIndex: number;
  liquidity: BN;
  feeOwedA: BN;
  feeOwedB: BN;
  rewardOwed: BN[];
}

export interface WhirlpoolInfo {
  address: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tickSpacing: number;
  sqrtPrice: BN;
  currentTickIndex: number;
  liquidity: BN;
  feeRate: number;
}

export interface PriceRange {
  lowerPrice: Decimal;
  upperPrice: Decimal;
  lowerTick: number;
  upperTick: number;
  centerPrice: Decimal;
}

export type OrcaClient = ReturnType<typeof buildWhirlpoolClient>;

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
 * Create Orca Whirlpool client
 */
export async function createOrcaClient(config: Config): Promise<{
  ctx: WhirlpoolContext;
  client: OrcaClient;
  wallet: Wallet;
  connection: Connection;
}> {
  const connection = new Connection(config.rpcUrl!, 'confirmed');
  const keypair = loadKeypair(config.walletKeypairPath);
  const wallet = new Wallet(keypair);
  
  logger.info(`Connected to ${config.cluster} via ${config.rpcUrl}`);
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);
  
  const ctx = WhirlpoolContext.from(
    connection,
    wallet,
    ORCA_WHIRLPOOL_PROGRAM_ID
  );
  
  const client = buildWhirlpoolClient(ctx);
  
  return { ctx, client, wallet, connection };
}

/**
 * Fetch Whirlpool data
 */
export async function getWhirlpoolInfo(
  client: OrcaClient,
  whirlpoolAddress: string
): Promise<WhirlpoolInfo> {
  const whirlpoolPubkey = new PublicKey(whirlpoolAddress);
  const whirlpool = await client.getPool(whirlpoolPubkey, IGNORE_CACHE);
  const data = whirlpool.getData();
  
  const info: WhirlpoolInfo = {
    address: whirlpoolPubkey,
    tokenMintA: data.tokenMintA,
    tokenMintB: data.tokenMintB,
    tickSpacing: data.tickSpacing,
    sqrtPrice: data.sqrtPrice,
    currentTickIndex: data.tickCurrentIndex,
    liquidity: data.liquidity,
    feeRate: data.feeRate,
  };
  
  logger.debug('Whirlpool info fetched', {
    address: info.address.toBase58(),
    currentTick: info.currentTickIndex,
    tickSpacing: info.tickSpacing,
  });
  
  return info;
}

/**
 * Get current price from Whirlpool
 */
export function getCurrentPrice(whirlpoolInfo: WhirlpoolInfo, decimalsA: number, decimalsB: number): Decimal {
  return PriceMath.sqrtPriceX64ToPrice(
    whirlpoolInfo.sqrtPrice,
    decimalsA,
    decimalsB
  );
}

/**
 * Calculate tick boundaries for a price range
 */
export function calculateTickRange(
  centerPrice: Decimal,
  rangeWidthPercent: number,
  tickSpacing: number,
  decimalsA: number,
  decimalsB: number
): PriceRange {
  // Calculate lower and upper prices
  const multiplier = new Decimal(1).plus(rangeWidthPercent);
  const lowerPrice = centerPrice.div(multiplier);
  const upperPrice = centerPrice.mul(multiplier);
  
  // Convert prices to tick indices
  let lowerTick = PriceMath.priceToInitializableTickIndex(
    lowerPrice,
    decimalsA,
    decimalsB,
    tickSpacing
  );
  
  let upperTick = PriceMath.priceToInitializableTickIndex(
    upperPrice,
    decimalsA,
    decimalsB,
    tickSpacing
  );
  
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
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): Decimal {
  return PriceMath.tickIndexToPrice(tick, decimalsA, decimalsB);
}

/**
 * Find existing positions for wallet in a Whirlpool
 */
export async function findPositions(
  ctx: WhirlpoolContext,
  client: OrcaClient,
  whirlpoolAddress: string,
  walletAddress: PublicKey
): Promise<PositionInfo[]> {
  const whirlpoolPubkey = new PublicKey(whirlpoolAddress);
  const positions: PositionInfo[] = [];
  
  try {
    // Get all token accounts owned by wallet
    const tokenAccounts = await ctx.connection.getParsedTokenAccountsByOwner(
      walletAddress,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );
    
    // Filter for position NFTs (amount = 1, decimals = 0)
    for (const { account } of tokenAccounts.value) {
      const tokenInfo = account.data.parsed?.info;
      if (!tokenInfo) continue;
      
      const amount = tokenInfo.tokenAmount?.uiAmount;
      const decimals = tokenInfo.tokenAmount?.decimals;
      
      if (amount === 1 && decimals === 0) {
        const mint = new PublicKey(tokenInfo.mint);
        
        // Derive position PDA from mint
        const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mint);
        
        try {
          const position = await client.getPosition(positionPda.publicKey, IGNORE_CACHE);
          const data = position.getData();
          
          if (data.whirlpool.equals(whirlpoolPubkey)) {
            positions.push({
              address: positionPda.publicKey,
              positionMint: mint,
              whirlpool: data.whirlpool,
              tickLowerIndex: data.tickLowerIndex,
              tickUpperIndex: data.tickUpperIndex,
              liquidity: data.liquidity,
              feeOwedA: data.feeOwedA,
              feeOwedB: data.feeOwedB,
              rewardOwed: [
                data.rewardInfos[0]?.amountOwed || new BN(0),
                data.rewardInfos[1]?.amountOwed || new BN(0),
                data.rewardInfos[2]?.amountOwed || new BN(0),
              ],
            });
          }
        } catch {
          // Not a whirlpool position NFT, skip
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
  ctx: WhirlpoolContext,
  client: OrcaClient,
  positionAddress: PublicKey,
  dryRun: boolean
): Promise<{ feeA: BN; feeB: BN; rewards: BN[] } | null> {
  logger.info(`Collecting fees from position ${positionAddress.toBase58()}`);
  
  const position = await client.getPosition(positionAddress, IGNORE_CACHE);
  const positionData = position.getData();
  
  if (dryRun) {
    logger.info('[DRY RUN] Would collect fees and rewards');
    return {
      feeA: positionData.feeOwedA,
      feeB: positionData.feeOwedB,
      rewards: positionData.rewardInfos.map(r => r.amountOwed),
    };
  }
  
  try {
    // Collect fees
    const feesTx = await position.collectFees();
    const sig1 = await feesTx.buildAndExecute();
    logger.info(`Fees collected. Tx: ${sig1}`);
    
    // Collect rewards
    const rewardsTx = await position.collectRewards();
    for (const tx of rewardsTx) {
      const sig = await tx.buildAndExecute();
      logger.info(`Rewards collected. Tx: ${sig}`);
    }
    
    return {
      feeA: positionData.feeOwedA,
      feeB: positionData.feeOwedB,
      rewards: positionData.rewardInfos.map(r => r.amountOwed),
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
  ctx: WhirlpoolContext,
  client: OrcaClient,
  positionAddress: PublicKey,
  dryRun: boolean
): Promise<boolean> {
  logger.info(`Closing position ${positionAddress.toBase58()}`);
  
  const position = await client.getPosition(positionAddress, IGNORE_CACHE);
  const positionData = position.getData();
  const whirlpool = await client.getPool(positionData.whirlpool, IGNORE_CACHE);
  
  if (dryRun) {
    logger.info('[DRY RUN] Would remove liquidity and close position', {
      liquidityToRemove: positionData.liquidity.toString(),
    });
    return true;
  }
  
  try {
    if (!positionData.liquidity.isZero()) {
      // Remove all liquidity first
      const slippage = Percentage.fromFraction(1, 100); // 1%
      
      const quote = decreaseLiquidityQuoteByLiquidity(
        positionData.liquidity,
        slippage,
        position,
        whirlpool
      );
      
      // Decrease liquidity
      const decreaseTx = await position.decreaseLiquidity(quote);
      const sig = await decreaseTx.buildAndExecute();
      logger.info(`Liquidity removed. Tx: ${sig}`);
    }
    
    // Close position by burning NFT and reclaiming rent
    const closeTx = await position.closeBundledPosition();
    const sig = await closeTx.buildAndExecute();
    logger.info(`Position closed. Tx: ${sig}`);
    
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
  ctx: WhirlpoolContext,
  client: OrcaClient,
  whirlpoolAddress: string,
  lowerTick: number,
  upperTick: number,
  dryRun: boolean
): Promise<PublicKey | null> {
  logger.info(`Opening new position: ticks [${lowerTick}, ${upperTick}]`);
  
  const whirlpoolPubkey = new PublicKey(whirlpoolAddress);
  const whirlpool = await client.getPool(whirlpoolPubkey, IGNORE_CACHE);
  
  if (dryRun) {
    logger.info('[DRY RUN] Would open new position', {
      lowerTick,
      upperTick,
    });
    return null;
  }
  
  try {
    const { positionMint, tx } = await whirlpool.openPosition(
      lowerTick,
      upperTick,
      Percentage.fromFraction(1, 100) // slippage
    );
    
    const signature = await tx.buildAndExecute();
    logger.info(`Position opened. Mint: ${positionMint.toBase58()}, Tx: ${signature}`);
    
    // Get position address from mint
    const positionPda = PDAUtil.getPosition(
      ORCA_WHIRLPOOL_PROGRAM_ID,
      positionMint
    );
    
    return positionPda.publicKey;
  } catch (error) {
    logger.error('Failed to open position', error);
    return null;
  }
}

/**
 * Deposit liquidity into a position
 */
export async function depositLiquidity(
  ctx: WhirlpoolContext,
  client: OrcaClient,
  positionAddress: PublicKey,
  tokenAAmount: BN,
  tokenBAmount: BN,
  dryRun: boolean
): Promise<boolean> {
  logger.info(`Depositing liquidity into position ${positionAddress.toBase58()}`);
  
  const position = await client.getPosition(positionAddress, IGNORE_CACHE);
  const positionData = position.getData();
  const whirlpool = await client.getPool(positionData.whirlpool, IGNORE_CACHE);
  const whirlpoolData = whirlpool.getData();
  
  // Use the larger amount as primary input
  const inputTokenA = tokenAAmount.gt(new BN(0));
  const inputAmount = inputTokenA ? tokenAAmount : tokenBAmount;
  
  if (inputAmount.isZero()) {
    logger.warn('No tokens to deposit');
    return true;
  }
  
  const slippage = Percentage.fromFraction(1, 100); // 1%
  
  const quote = increaseLiquidityQuoteByInputToken(
    inputTokenA ? whirlpoolData.tokenMintA : whirlpoolData.tokenMintB,
    inputAmount,
    positionData.tickLowerIndex,
    positionData.tickUpperIndex,
    slippage,
    whirlpool
  );
  
  if (dryRun) {
    logger.info('[DRY RUN] Would deposit liquidity', {
      estimatedLiquidity: quote.liquidityAmount.toString(),
      tokenAMax: quote.tokenMaxA.toString(),
      tokenBMax: quote.tokenMaxB.toString(),
    });
    return true;
  }
  
  try {
    const increaseTx = await position.increaseLiquidity(quote);
    const signature = await increaseTx.buildAndExecute();
    logger.info(`Liquidity deposited. Tx: ${signature}`);
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
  tokenMintA: PublicKey,
  tokenMintB: PublicKey
): Promise<{ balanceA: BN; balanceB: BN }> {
  const { getAssociatedTokenAddress } = await import('@solana/spl-token');
  
  try {
    const ataA = await getAssociatedTokenAddress(tokenMintA, walletAddress);
    const ataB = await getAssociatedTokenAddress(tokenMintB, walletAddress);
    
    const [accountA, accountB] = await Promise.all([
      connection.getTokenAccountBalance(ataA).catch(() => null),
      connection.getTokenAccountBalance(ataB).catch(() => null),
    ]);
    
    return {
      balanceA: new BN(accountA?.value.amount || '0'),
      balanceB: new BN(accountB?.value.amount || '0'),
    };
  } catch (error) {
    logger.warn('Could not fetch token balances', error);
    return { balanceA: new BN(0), balanceB: new BN(0) };
  }
}

/**
 * Get token decimals
 */
export async function getTokenDecimals(
  connection: Connection,
  tokenMint: PublicKey
): Promise<number> {
  try {
    const info = await connection.getParsedAccountInfo(tokenMint);
    const data = (info.value?.data as any)?.parsed?.info;
    return data?.decimals || 9;
  } catch {
    return 9;
  }
}
