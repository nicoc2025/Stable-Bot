/**
 * Strategy module for Orca LP Range Manager
 * Implements trigger logic with dwell time and anti-thrashing
 */

import { getLogger } from './logger.js';
import type { WhirlpoolInfo, PositionInfo, PriceRange } from './orca.js';
import { isPriceInRange, calculateEdgeDistance, tickToPrice } from './orca.js';

const logger = getLogger('Strategy');

export type TriggerReason = 
  | 'out_of_range'
  | 'near_lower_edge'
  | 'near_upper_edge'
  | 'none';

export interface StrategyState {
  // Current trigger condition
  triggerReason: TriggerReason;
  
  // Dwell tracking
  dwellStartTime: number | null;
  dwellReason: TriggerReason | null;
  
  // Anti-thrashing
  lastRebalanceTime: number;
  
  // Position state
  currentPosition: PositionInfo | null;
  currentPriceRange: PriceRange | null;
}

export interface StrategyParams {
  rangeWidthPercent: number;
  edgeBufferPercent: number;
  dwellSeconds: number;
  minRebalanceIntervalSeconds: number;
}

export interface TriggerResult {
  shouldRebalance: boolean;
  reason: TriggerReason;
  details: {
    currentTick: number;
    currentPrice: number;
    lowerTick: number;
    upperTick: number;
    lowerPrice: number;
    upperPrice: number;
    edgeDistance?: { lower: number; upper: number };
    dwellElapsed?: number;
    timeSinceLastRebalance?: number;
  };
}

/**
 * Create initial strategy state
 */
export function createStrategyState(): StrategyState {
  return {
    triggerReason: 'none',
    dwellStartTime: null,
    dwellReason: null,
    lastRebalanceTime: 0,
    currentPosition: null,
    currentPriceRange: null,
  };
}

/**
 * Evaluate current conditions and determine if rebalance should trigger
 */
export function evaluateTrigger(
  state: StrategyState,
  whirlpoolInfo: WhirlpoolInfo,
  position: PositionInfo,
  params: StrategyParams,
  decimalsA: number,
  decimalsB: number
): TriggerResult {
  const currentTick = whirlpoolInfo.currentTickIndex;
  const currentPrice = tickToPrice(currentTick, decimalsA, decimalsB);
  
  const lowerTick = position.tickLowerIndex;
  const upperTick = position.tickUpperIndex;
  const lowerPrice = tickToPrice(lowerTick, decimalsA, decimalsB);
  const upperPrice = tickToPrice(upperTick, decimalsA, decimalsB);
  
  // Check if price is out of range
  const inRange = isPriceInRange(currentTick, lowerTick, upperTick);
  
  let triggerReason: TriggerReason = 'none';
  
  if (!inRange) {
    // Price is completely out of range - always trigger
    triggerReason = 'out_of_range';
    logger.outOfRange(currentPrice, lowerPrice, upperPrice);
  } else if (params.edgeBufferPercent > 0) {
    // Check edge buffer conditions
    const edgeDistance = calculateEdgeDistance(currentTick, lowerTick, upperTick);
    
    if (edgeDistance.lower < params.edgeBufferPercent) {
      triggerReason = 'near_lower_edge';
      logger.edgeHit('lower', currentPrice, lowerPrice);
    } else if (edgeDistance.upper < params.edgeBufferPercent) {
      triggerReason = 'near_upper_edge';
      logger.edgeHit('upper', currentPrice, upperPrice);
    }
  }
  
  return {
    shouldRebalance: triggerReason !== 'none',
    reason: triggerReason,
    details: {
      currentTick,
      currentPrice,
      lowerTick,
      upperTick,
      lowerPrice,
      upperPrice,
      edgeDistance: inRange 
        ? { lower: calculateEdgeDistance(currentTick, lowerTick, upperTick).lower, upper: calculateEdgeDistance(currentTick, lowerTick, upperTick).upper }
        : undefined,
    },
  };
}

/**
 * Process dwell time logic
 * Returns true if dwell period has completed, false otherwise
 */
export function processDwell(
  state: StrategyState,
  triggerResult: TriggerResult,
  params: StrategyParams
): { dwellCompleted: boolean; state: StrategyState } {
  const now = Date.now();
  const newState = { ...state };
  
  if (!triggerResult.shouldRebalance) {
    // Condition not met - reset dwell if it was active
    if (state.dwellStartTime !== null) {
      logger.dwellReset(`Condition cleared (was: ${state.dwellReason})`);
      newState.dwellStartTime = null;
      newState.dwellReason = null;
    }
    return { dwellCompleted: false, state: newState };
  }
  
  // Condition is met
  if (state.dwellStartTime === null || state.dwellReason !== triggerResult.reason) {
    // Start new dwell period
    logger.dwellStarted(triggerResult.reason, params.dwellSeconds);
    newState.dwellStartTime = now;
    newState.dwellReason = triggerResult.reason;
    return { dwellCompleted: false, state: newState };
  }
  
  // Check if dwell period has completed
  const elapsedSeconds = (now - state.dwellStartTime) / 1000;
  
  if (elapsedSeconds >= params.dwellSeconds) {
    logger.info(`Dwell completed after ${elapsedSeconds.toFixed(1)}s`);
    return { dwellCompleted: true, state: newState };
  }
  
  logger.debug(`Dwell in progress: ${elapsedSeconds.toFixed(1)}s / ${params.dwellSeconds}s`);
  return { dwellCompleted: false, state: newState };
}

/**
 * Check anti-thrashing cooldown
 */
export function checkCooldown(
  state: StrategyState,
  params: StrategyParams
): { canRebalance: boolean; timeRemaining: number } {
  const now = Date.now();
  const timeSinceLastRebalance = (now - state.lastRebalanceTime) / 1000;
  
  if (timeSinceLastRebalance < params.minRebalanceIntervalSeconds) {
    const timeRemaining = params.minRebalanceIntervalSeconds - timeSinceLastRebalance;
    logger.rebalanceSkipped(`Cooldown active: ${timeRemaining.toFixed(0)}s remaining`);
    return { canRebalance: false, timeRemaining };
  }
  
  return { canRebalance: true, timeRemaining: 0 };
}

/**
 * Full strategy evaluation - combines trigger, dwell, and cooldown checks
 */
export function runStrategyEvaluation(
  state: StrategyState,
  whirlpoolInfo: WhirlpoolInfo,
  position: PositionInfo,
  params: StrategyParams,
  decimalsA: number,
  decimalsB: number
): {
  shouldRebalance: boolean;
  reason: TriggerReason;
  newState: StrategyState;
  details: TriggerResult['details'];
} {
  // Step 1: Evaluate trigger conditions
  const triggerResult = evaluateTrigger(
    state,
    whirlpoolInfo,
    position,
    params,
    decimalsA,
    decimalsB
  );
  
  // Step 2: Process dwell time
  const { dwellCompleted, state: stateAfterDwell } = processDwell(
    state,
    triggerResult,
    params
  );
  
  // If dwell not completed, don't rebalance
  if (!dwellCompleted) {
    return {
      shouldRebalance: false,
      reason: triggerResult.reason,
      newState: stateAfterDwell,
      details: triggerResult.details,
    };
  }
  
  // Step 3: Check cooldown
  const { canRebalance, timeRemaining } = checkCooldown(stateAfterDwell, params);
  
  if (!canRebalance) {
    return {
      shouldRebalance: false,
      reason: triggerResult.reason,
      newState: stateAfterDwell,
      details: {
        ...triggerResult.details,
        timeSinceLastRebalance: params.minRebalanceIntervalSeconds - timeRemaining,
      },
    };
  }
  
  // All conditions met - should rebalance
  return {
    shouldRebalance: true,
    reason: triggerResult.reason,
    newState: stateAfterDwell,
    details: triggerResult.details,
  };
}

/**
 * Mark rebalance as completed in state
 */
export function markRebalanceComplete(state: StrategyState): StrategyState {
  return {
    ...state,
    lastRebalanceTime: Date.now(),
    dwellStartTime: null,
    dwellReason: null,
    triggerReason: 'none',
  };
}

/**
 * Format position status for display
 */
export function formatPositionStatus(
  whirlpoolInfo: WhirlpoolInfo,
  position: PositionInfo | null,
  decimalsA: number,
  decimalsB: number
): string {
  const currentPrice = tickToPrice(whirlpoolInfo.currentTickIndex, decimalsA, decimalsB);
  
  const lines = [
    '═══════════════════════════════════════════════════════════',
    '                    POSITION STATUS',
    '═══════════════════════════════════════════════════════════',
    `  Whirlpool: ${whirlpoolInfo.address}`,
    `  Current Tick: ${whirlpoolInfo.currentTickIndex}`,
    `  Current Price: ${currentPrice.toFixed(6)}`,
    `  Pool Liquidity: ${whirlpoolInfo.liquidity.toString()}`,
    '',
  ];
  
  if (position) {
    const lowerPrice = tickToPrice(position.tickLowerIndex, decimalsA, decimalsB);
    const upperPrice = tickToPrice(position.tickUpperIndex, decimalsA, decimalsB);
    const inRange = isPriceInRange(
      whirlpoolInfo.currentTickIndex,
      position.tickLowerIndex,
      position.tickUpperIndex
    );
    
    lines.push(
      '  ACTIVE POSITION:',
      `  Address: ${position.address}`,
      `  Tick Range: [${position.tickLowerIndex}, ${position.tickUpperIndex}]`,
      `  Price Range: [${lowerPrice.toFixed(6)}, ${upperPrice.toFixed(6)}]`,
      `  Liquidity: ${position.liquidity.toString()}`,
      `  In Range: ${inRange ? '✓ YES' : '✗ NO'}`,
      `  Fees Owed: A=${position.feeOwedA.toString()}, B=${position.feeOwedB.toString()}`,
    );
  } else {
    lines.push('  NO ACTIVE POSITION');
  }
  
  lines.push('═══════════════════════════════════════════════════════════');
  
  return lines.join('\n');
}
