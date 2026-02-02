/**
 * SOL Price fetcher with caching
 * Uses CoinGecko free API
 */

import { getLogger } from './logger.js';

const logger = getLogger('Price');

// Cache configuration
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Cache state
let cachedPrice: number | null = null;
let lastFetchTime: number = 0;

/**
 * Fetch current SOL price in USD from CoinGecko
 * Returns cached value if within cache duration
 * Returns last known price if API fails
 * Returns null if never successfully fetched
 */
export async function getSolPriceUsd(): Promise<number | null> {
  const now = Date.now();
  
  // Return cached price if still valid
  if (cachedPrice !== null && (now - lastFetchTime) < CACHE_DURATION_MS) {
    return cachedPrice;
  }
  
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      {
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      }
    );
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const price = data?.solana?.usd;
    
    if (typeof price === 'number' && price > 0) {
      cachedPrice = price;
      lastFetchTime = now;
      logger.debug(`SOL price updated: $${price.toFixed(2)}`);
      return price;
    }
    
    throw new Error('Invalid price data');
  } catch (error) {
    logger.debug('Failed to fetch SOL price, using cached value', error);
    // Return last known price (may be null if never fetched)
    return cachedPrice;
  }
}

/**
 * Convert lamports to USD
 * Returns null if price unavailable
 */
export async function lamportsToUsd(lamports: number): Promise<number | null> {
  const price = await getSolPriceUsd();
  if (price === null) return null;
  
  const sol = lamports / 1_000_000_000;
  return sol * price;
}

/**
 * Format SOL amount with optional USD conversion
 */
export async function formatSolWithUsd(lamports: number): Promise<string> {
  const sol = lamports / 1_000_000_000;
  const usd = await lamportsToUsd(lamports);
  
  if (usd !== null) {
    return `${sol.toFixed(6)} SOL (≈ $${usd.toFixed(2)})`;
  }
  return `${sol.toFixed(6)} SOL`;
}

/**
 * Get the last cached price (for display purposes)
 * Does not trigger a fetch
 */
export function getCachedSolPrice(): number | null {
  return cachedPrice;
}
