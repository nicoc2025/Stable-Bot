/**
 * Rebalance module for Orca LP Range Manager
 * Handles full LP position migration: withdraw → open new → redeposit
 */

import BN from 'bn.js';
import { getLogger } from './logger.js';
import {
  createOrcaClient,
  getCurrentPrice,
  calculateTickRange,
  collectFeesAndRewards,
  closePosition,
  openPosition,
  depositLiquidity,
  getTokenBalances,
  type PositionInfo,
  type WhirlpoolInfo,
  type PriceRange,
} from './orca.js';
import type { Config } from './config.js';
import type { StrategyState } from './strategy.js';
import { markRebalanceComplete, markRebalanceFailed } from './strategy.js';

const logger = getLogger('Rebalance');

export interface RebalanceResult {
  success: boolean;
  oldPosition?: {
    address: string;
    tickLower: number;
    tickUpper: number;
  };
  newPosition?: {
    address: string;
    tickLower: number;
    tickUpper: number;
  };
  feesCollected?: {
    tokenA: string;
    tokenB: string;
  };
  error?: string;
  transactions: string[];
}

/**
 * Execute full rebalance operation
 * 1. Collect fees and rewards from old position
 * 2. Remove all liquidity from old position
 * 3. Close old position
 * 4. Open new position centered on current price
 * 5. Deposit available liquidity
 */
export async function executeRebalance(
  config: Config,
  state: StrategyState,
  currentPosition: PositionInfo,
  whirlpoolInfo: WhirlpoolInfo,
  decimalsA: number,
  decimalsB: number
): Promise<{ result: RebalanceResult; newState: StrategyState }> {
  const { ctx, client, wallet, connection } = await createOrcaClient(config);
  const transactions: string[] = [];
  
  logger.info('Starting rebalance operation...');
  
  const result: RebalanceResult = {
    success: false,
    oldPosition: {
      address: currentPosition.address.toBase58(),
      tickLower: currentPosition.tickLowerIndex,
      tickUpper: currentPosition.tickUpperIndex,
    },
    transactions,
  };
  
  try {
    // Step 1: Collect fees and rewards
    logger.info('Step 1/5: Collecting fees and rewards...');
    const fees = await collectFeesAndRewards(
      ctx,
      client,
      currentPosition.address,
      config.dryRun
    );
    
    if (fees) {
      result.feesCollected = {
        tokenA: fees.feeA.toString(),
        tokenB: fees.feeB.toString(),
      };
    }
    
    // Step 2 & 3: Close old position (removes liquidity and closes)
    logger.info('Step 2/5: Removing liquidity from old position...');
    logger.info('Step 3/5: Closing old position...');
    const closed = await closePosition(
      ctx,
      client,
      currentPosition.address,
      config.dryRun
    );
    
    if (!closed && !config.dryRun) {
      throw new Error('Failed to close old position');
    }
    
    // Step 4: Calculate new range and open position
    logger.info('Step 4/5: Opening new position...');
    const currentPrice = getCurrentPrice(whirlpoolInfo, decimalsA, decimalsB);
    const newRange = await calculateTickRange(
      currentPrice,
      config.rangeWidthPercent,
      whirlpoolInfo.tickSpacing,
      decimalsA,
      decimalsB
    );
    
    logger.info('New position range:', {
      centerPrice: currentPrice.toFixed(6),
      lowerPrice: newRange.lowerPrice.toFixed(6),
      upperPrice: newRange.upperPrice.toFixed(6),
      lowerTick: newRange.lowerTick,
      upperTick: newRange.upperTick,
    });
    
    const newPositionAddress = await openPosition(
      ctx,
      client,
      config.whirlpoolAddress,
      newRange.lowerTick,
      newRange.upperTick,
      config.dryRun
    );
    
    if (!newPositionAddress && !config.dryRun) {
      throw new Error('Failed to open new position');
    }
    
    if (newPositionAddress || config.dryRun) {
      result.newPosition = {
        address: newPositionAddress?.toBase58() || '[DRY RUN]',
        tickLower: newRange.lowerTick,
        tickUpper: newRange.upperTick,
      };
    }
    
    // Step 5: Deposit available liquidity
    logger.info('Step 5/5: Depositing liquidity...');
    const balances = await getTokenBalances(
      connection,
      wallet.publicKey,
      whirlpoolInfo.tokenMintA,
      whirlpoolInfo.tokenMintB
    );
    
    logger.info('Available balances:', {
      tokenA: balances.balanceA.toString(),
      tokenB: balances.balanceB.toString(),
    });
    
    if ((!balances.balanceA.isZero() || !balances.balanceB.isZero()) && newPositionAddress) {
      const deposited = await depositLiquidity(
        ctx,
        client,
        newPositionAddress,
        balances.balanceA,
        balances.balanceB,
        config.dryRun
      );
      
      if (!deposited && !config.dryRun) {
        logger.warn('Liquidity deposit failed - position is open but empty');
      }
    }
    
    result.success = true;
    
    // Log rebalance completion
    logger.rebalanceExecuted({
      oldLowerTick: currentPosition.tickLowerIndex,
      oldUpperTick: currentPosition.tickUpperIndex,
      newLowerTick: newRange.lowerTick,
      newUpperTick: newRange.upperTick,
      newCenterPrice: currentPrice.toNumber(),
      feesCollected: result.feesCollected,
      txSignatures: transactions,
    });
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error('Rebalance failed', error);
  }
  
  // Update state - use markRebalanceFailed if failed to reset dwell without starting cooldown
  const newState = result.success 
    ? markRebalanceComplete(state) 
    : markRebalanceFailed(state);
  
  return { result, newState };
}

/**
 * Simulate rebalance without executing (for dry run mode)
 */
export async function simulateRebalance(
  currentPosition: PositionInfo,
  whirlpoolInfo: WhirlpoolInfo,
  rangeWidthPercent: number,
  decimalsA: number,
  decimalsB: number
): Promise<{
  currentRange: PriceRange;
  newRange: PriceRange;
}> {
  const currentPrice = getCurrentPrice(whirlpoolInfo, decimalsA, decimalsB);
  
  // Current position range (with zero prices - we don't need them here)
  const currentRange: PriceRange = {
    lowerTick: currentPosition.tickLowerIndex,
    upperTick: currentPosition.tickUpperIndex,
    lowerPrice: 0 as any,
    upperPrice: 0 as any,
    centerPrice: currentPrice,
  };
  
  // Calculate new range
  const newRange = await calculateTickRange(
    currentPrice,
    rangeWidthPercent,
    whirlpoolInfo.tickSpacing,
    decimalsA,
    decimalsB
  );
  
  return { currentRange, newRange };
}

/**
 * Print rebalance preview
 */
export async function printRebalancePreview(
  currentPosition: PositionInfo,
  whirlpoolInfo: WhirlpoolInfo,
  config: Config,
  decimalsA: number,
  decimalsB: number
): Promise<void> {
  const { currentRange, newRange } = await simulateRebalance(
    currentPosition,
    whirlpoolInfo,
    config.rangeWidthPercent,
    decimalsA,
    decimalsB
  );
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                  REBALANCE PREVIEW');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Mode: ${config.dryRun ? 'DRY RUN (no transactions)' : 'LIVE'}`);
  console.log('');
  console.log('  CURRENT POSITION:');
  console.log(`    Tick Range: [${currentRange.lowerTick}, ${currentRange.upperTick}]`);
  console.log(`    Liquidity: ${currentPosition.liquidity.toString()}`);
  console.log('');
  console.log('  NEW POSITION (after rebalance):');
  console.log(`    Center Price: ${newRange.centerPrice.toFixed(6)}`);
  console.log(`    Price Range: [${newRange.lowerPrice.toFixed(6)}, ${newRange.upperPrice.toFixed(6)}]`);
  console.log(`    Tick Range: [${newRange.lowerTick}, ${newRange.upperTick}]`);
  console.log('');
  console.log('  OPERATIONS:');
  console.log('    1. Collect fees and rewards');
  console.log('    2. Remove liquidity from old position');
  console.log('    3. Close old position');
  console.log('    4. Open new position with updated range');
  console.log('    5. Deposit available tokens');
  console.log('═══════════════════════════════════════════════════════════\n');
}
