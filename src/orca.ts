/**
 * Orca Whirlpools SDK helpers
 * Handles all interactions with Orca Whirlpools on Solana
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
  IGNORE_CACHE,
  getAllPositionAccountsByOwner,
  decreaseLiquidityQuoteByLiquidityWithParams,
  increaseLiquidityQuoteByInputTokenWithParams,
} from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import { getLogger } from './logger.js';
import BN from 'bn.js';
import type { Config } from './config.js';

const logger = getLogger('Orca');

// Dynamic import for Decimal to handle ESM correctly
let Decimal: any;
async function getDecimal() {
  if (!Decimal) {
    Decimal = (await import('decimal.js')).default;
  }
  return Decimal;
}

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
  lowerPrice: any;
  upperPrice: any;
  lowerTick: number;
  upperTick: number;
  centerPrice: any;
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
  const wallet = new Wallet(keypair as any);
  
  logger.info(`Connected to ${config.cluster} via ${config.rpcUrl}`);
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);
  
  const ctx = WhirlpoolContext.from(
    connection,
    wallet as any
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
export function getCurrentPrice(whirlpoolInfo: WhirlpoolInfo, decimalsA: number, decimalsB: number): any {
  return PriceMath.sqrtPriceX64ToPrice(
    whirlpoolInfo.sqrtPrice,
    decimalsA,
    decimalsB
  );
}

/**
 * Calculate tick boundaries for a price range
 */
export async function calculateTickRange(
  centerPrice: any,
  rangeWidthPercent: number,
  tickSpacing: number,
  decimalsA: number,
  decimalsB: number
): Promise<PriceRange> {
  const D = await getDecimal();
  
  // Calculate lower and upper prices
  const multiplier = new D(1).plus(rangeWidthPercent);
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
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): any {
  return PriceMath.tickIndexToPrice(tick, decimalsA, decimalsB);
}

/**
 * Find existing positions for wallet in a Whirlpool
 * Uses token account scanning to find position NFTs owned by the wallet
 */
export async function findPositions(
  ctx: WhirlpoolContext,
  client: OrcaClient,
  whirlpoolAddress: string,
  walletAddress: PublicKey
): Promise<PositionInfo[]> {
  const whirlpoolPubkey = new PublicKey(whirlpoolAddress);
  const positions: PositionInfo[] = [];
  
  logger.debug(`Scanning for positions in Whirlpool: ${whirlpoolAddress}`);
  logger.debug(`Wallet address: ${walletAddress.toBase58()}`);
  
  try {
    // Method 1: Try the SDK's getAllPositionAccountsByOwner first
    try {
      const allPositions = await getAllPositionAccountsByOwner({
        ctx,
        owner: walletAddress,
      });
      
      logger.debug(`getAllPositionAccountsByOwner returned: ${typeof allPositions}`);
      
      // Handle different return types (Map, Array, or object)
      if (allPositions) {
        const entries = allPositions instanceof Map 
          ? Array.from(allPositions.entries())
          : Array.isArray(allPositions)
            ? allPositions.map((p: any, i: number) => [i, p])
            : Object.entries(allPositions);
        
        logger.debug(`Found ${entries.length} total positions for wallet`);
        
        // Log ALL positions to help identify the correct whirlpool address
        logger.info(`=== ALL POSITIONS IN WALLET ===`);
        for (const [key, posData] of entries) {
          if (posData && posData.whirlpool) {
            logger.info(`  Position: ${key}`);
            logger.info(`    Whirlpool: ${posData.whirlpool.toBase58()}`);
            logger.info(`    Tick Range: [${posData.tickLowerIndex}, ${posData.tickUpperIndex}]`);
            logger.info(`    Liquidity: ${posData.liquidity?.toString() || 'N/A'}`);
          }
        }
        logger.info(`=== TARGET WHIRLPOOL: ${whirlpoolPubkey.toBase58()} ===`);
        
        for (const [key, posData] of entries) {
          if (posData && posData.whirlpool) {
            logger.debug(`Position whirlpool: ${posData.whirlpool.toBase58()}, target: ${whirlpoolPubkey.toBase58()}`);
            if (posData.whirlpool.equals(whirlpoolPubkey)) {
              const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, posData.positionMint);
              positions.push({
                address: positionPda.publicKey,
                positionMint: posData.positionMint,
                whirlpool: posData.whirlpool,
                tickLowerIndex: posData.tickLowerIndex,
                tickUpperIndex: posData.tickUpperIndex,
                liquidity: posData.liquidity,
                feeOwedA: posData.feeOwedA || new BN(0),
                feeOwedB: posData.feeOwedB || new BN(0),
                rewardOwed: posData.rewardInfos?.map((r: any) => r.amountOwed) || [],
              });
            }
          }
        }
      }
    } catch (sdkError) {
      logger.debug('SDK getAllPositionAccountsByOwner failed, trying alternative method', sdkError);
    }
    
    // Method 2: If SDK method failed or found no positions, scan token accounts
    if (positions.length === 0) {
      logger.debug('Using token account scanning method...');
      const foundPositions = await scanTokenAccountsForPositions(
        ctx.connection,
        walletAddress,
        whirlpoolPubkey
      );
      positions.push(...foundPositions);
    }
    
  } catch (error) {
    logger.warn('Could not list positions', error);
  }
  
  logger.info(`Found ${positions.length} position(s) in Whirlpool`);
  return positions;
}

/**
 * Alternative method: Scan wallet's token accounts for position NFTs
 * Position NFTs have supply of 1 and decimals of 0
 */
async function scanTokenAccountsForPositions(
  connection: Connection,
  walletAddress: PublicKey,
  whirlpoolPubkey: PublicKey
): Promise<PositionInfo[]> {
  const positions: PositionInfo[] = [];
  const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  
  try {
    // Get all token accounts owned by the wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletAddress,
      { programId: TOKEN_PROGRAM_ID }
    );
    
    logger.debug(`Found ${tokenAccounts.value.length} token accounts for wallet`);
    
    // Filter for NFTs (amount = 1, decimals = 0 - typical for position NFTs)
    const potentialNFTs = tokenAccounts.value.filter(account => {
      const info = account.account.data.parsed.info;
      return info.tokenAmount.decimals === 0 && 
             info.tokenAmount.uiAmount === 1;
    });
    
    logger.debug(`Found ${potentialNFTs.length} potential position NFTs`);
    
    // For each potential NFT, try to derive and fetch the position account
    for (const nftAccount of potentialNFTs) {
      const mintAddress = new PublicKey(nftAccount.account.data.parsed.info.mint);
      
      try {
        // Derive position PDA from mint
        const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintAddress);
        
        // Try to fetch position data
        const positionAccountInfo = await connection.getAccountInfo(positionPda.publicKey);
        
        if (positionAccountInfo && positionAccountInfo.data) {
          // Parse position data manually
          // Position account layout: discriminator (8) + whirlpool (32) + positionMint (32) + liquidity (16) + ...
          const data = positionAccountInfo.data;
          
          // Skip discriminator (8 bytes) and read whirlpool pubkey (32 bytes)
          const positionWhirlpool = new PublicKey(data.slice(8, 40));
          
          logger.debug(`NFT ${mintAddress.toBase58().slice(0,8)}... -> Whirlpool: ${positionWhirlpool.toBase58().slice(0,8)}...`);
          
          if (positionWhirlpool.equals(whirlpoolPubkey)) {
            // Parse remaining fields
            // positionMint: bytes 40-72
            const positionMint = new PublicKey(data.slice(40, 72));
            
            // liquidity: bytes 72-88 (u128 as two u64s, we'll use first 8 bytes as BN)
            const liquidityBytes = data.slice(72, 88);
            const liquidity = new BN(liquidityBytes, 'le');
            
            // tickLowerIndex: bytes 88-92 (i32)
            const tickLowerIndex = data.readInt32LE(88);
            
            // tickUpperIndex: bytes 92-96 (i32)
            const tickUpperIndex = data.readInt32LE(92);
            
            // feeOwedA: bytes 96-104 (u64)
            const feeOwedA = new BN(data.slice(96, 104), 'le');
            
            // feeOwedB: bytes 104-112 (u64)
            const feeOwedB = new BN(data.slice(104, 112), 'le');
            
            logger.info(`Found matching position: ${positionPda.publicKey.toBase58()}`);
            logger.info(`  Tick range: [${tickLowerIndex}, ${tickUpperIndex}]`);
            logger.info(`  Liquidity: ${liquidity.toString()}`);
            
            positions.push({
              address: positionPda.publicKey,
              positionMint: positionMint,
              whirlpool: positionWhirlpool,
              tickLowerIndex,
              tickUpperIndex,
              liquidity,
              feeOwedA,
              feeOwedB,
              rewardOwed: [],
            });
          }
        }
      } catch (posError) {
        // Not a valid position NFT, skip
        logger.debug(`NFT ${mintAddress.toBase58().slice(0,8)}... is not a position NFT`);
      }
    }
  } catch (error) {
    logger.error('Token account scanning failed', error);
  }
  
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
 * Empty token extension context for non-Token2022 tokens
 */
function getEmptyTokenExtensionCtx() {
  return {
    currentEpoch: 0,
    tokenMintWithProgramA: { address: PublicKey.default, tokenProgram: PublicKey.default },
    tokenMintWithProgramB: { address: PublicKey.default, tokenProgram: PublicKey.default },
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
      rewards: positionData.rewardInfos.map((r: any) => r.amountOwed),
    };
  }
  
  try {
    // Collect fees
    const feesTx = await position.collectFees();
    const sig1 = await feesTx.buildAndExecute();
    logger.info(`Fees collected. Tx: ${sig1}`);
    
    // Collect rewards
    const rewardsTxs = await position.collectRewards();
    for (const tx of rewardsTxs) {
      const sig = await tx.buildAndExecute();
      logger.info(`Rewards collected. Tx: ${sig}`);
    }
    
    return {
      feeA: positionData.feeOwedA,
      feeB: positionData.feeOwedB,
      rewards: positionData.rewardInfos.map((r: any) => r.amountOwed),
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
      // Remove all liquidity first using decreaseLiquidity
      const slippage = Percentage.fromFraction(1, 100); // 1%
      const whirlpoolData = whirlpool.getData();
      
      const quote = decreaseLiquidityQuoteByLiquidityWithParams({
        sqrtPrice: whirlpoolData.sqrtPrice,
        tickCurrentIndex: whirlpoolData.tickCurrentIndex,
        tickLowerIndex: positionData.tickLowerIndex,
        tickUpperIndex: positionData.tickUpperIndex,
        liquidity: positionData.liquidity,
        slippageTolerance: slippage,
        tokenExtensionCtx: getEmptyTokenExtensionCtx() as any,
      });
      
      // Decrease liquidity
      const decreaseTx = await position.decreaseLiquidity(quote);
      const sig = await decreaseTx.buildAndExecute();
      logger.info(`Liquidity removed. Tx: ${sig}`);
    }
    
    // Collect remaining fees to finalize position
    const closeTx = await position.collectFees();
    const sig = await closeTx.buildAndExecute();
    logger.info(`Position finalized. Tx: ${sig}`);
    
    return true;
  } catch (error) {
    logger.error('Failed to close position', error);
    return false;
  }
}

/**
 * Open a new position with specified range (NO metadata = cheaper)
 * Uses raw instruction building to avoid expensive metadata account creation
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
    // Use openPosition (NOT openPositionWithMetadata) to save ~0.01+ SOL
    // The SDK's whirlpool.openPosition internally may still create metadata
    // So we build the instruction manually for maximum cost savings
    const { WhirlpoolIx, TickUtil } = await import('@orca-so/whirlpools-sdk');
    const { Keypair: SolanaKeypair, SystemProgram, Transaction } = await import('@solana/web3.js');
    const { 
      TOKEN_PROGRAM_ID, 
      TOKEN_2022_PROGRAM_ID,
      getAssociatedTokenAddressSync,
      createAssociatedTokenAccountInstruction,
      ASSOCIATED_TOKEN_PROGRAM_ID
    } = await import('@solana/spl-token');
    
    const whirlpoolData = whirlpool.getData();
    const wallet = ctx.wallet;
    
    // Generate new position mint keypair
    const positionMintKeypair = SolanaKeypair.generate();
    const positionMint = positionMintKeypair.publicKey;
    
    // Derive position PDA
    const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint);
    
    // Derive position token account (ATA for the position NFT)
    const positionTokenAccount = getAssociatedTokenAddressSync(
      positionMint,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    
    // Get tick arrays for the position
    const tickLowerArrayPda = PDAUtil.getTickArrayFromTickIndex(
      lowerTick,
      whirlpoolData.tickSpacing,
      whirlpoolPubkey,
      ORCA_WHIRLPOOL_PROGRAM_ID
    );
    const tickUpperArrayPda = PDAUtil.getTickArrayFromTickIndex(
      upperTick,
      whirlpoolData.tickSpacing,
      whirlpoolPubkey,
      ORCA_WHIRLPOOL_PROGRAM_ID
    );
    
    logger.info(`Creating position with mint: ${positionMint.toBase58()}`);
    
    // Build the openPosition instruction (without metadata)
    const openPositionIx = WhirlpoolIx.openPositionIx(ctx.program, {
      whirlpool: whirlpoolPubkey,
      owner: wallet.publicKey,
      positionPda: positionPda,
      positionMintAddress: positionMint,
      positionTokenAccount: positionTokenAccount,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
      funder: wallet.publicKey,
    });
    
    // Build transaction
    const tx = new Transaction();
    tx.add(...openPositionIx.instructions);
    
    // Sign and send
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
    
    // Sign with both wallet and position mint keypair
    tx.partialSign(positionMintKeypair);
    const signedTx = await wallet.signTransaction(tx);
    
    const signature = await ctx.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await ctx.connection.confirmTransaction(signature, 'confirmed');
    
    logger.info(`Position opened (no metadata, cheaper). Mint: ${positionMint.toBase58()}, Tx: ${signature}`);
    
    return positionPda.publicKey;
  } catch (error: any) {
    logger.warn(`Raw openPosition failed: ${error.message}, falling back to SDK method...`);
    
    // Fallback to SDK method if raw instruction fails
    try {
      const { positionMint, tx } = await whirlpool.openPosition(
        lowerTick,
        upperTick,
        Percentage.fromFraction(1, 100) as any
      );
      
      const signature = await tx.buildAndExecute();
      logger.info(`Position opened (SDK fallback). Mint: ${positionMint.toBase58()}, Tx: ${signature}`);
      
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint);
      return positionPda.publicKey;
    } catch (fallbackError) {
      logger.error('Both position open methods failed', fallbackError);
      return null;
    }
  }
}

/**
 * Deposit liquidity into a position
 * Handles Token-2022 transfer fees by trying progressively smaller amounts
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
  
  if (tokenAAmount.isZero() && tokenBAmount.isZero()) {
    logger.warn('No tokens to deposit');
    return true;
  }
  
  if (dryRun) {
    logger.info('[DRY RUN] Would deposit liquidity', {
      tokenA: tokenAAmount.toString(),
      tokenB: tokenBAmount.toString(),
    });
    return true;
  }
  
  // For Token-2022 with transfer fees, we need to account for the fee deduction
  // Try progressively smaller percentages until one works
  const percentagesToTry = [90, 85, 80, 75, 70, 60, 50];
  
  for (const percent of percentagesToTry) {
    try {
      logger.info(`Attempting deposit with ${percent}% of available balance...`);
      
      // Apply percentage reduction to account for transfer fees
      const adjustedA = tokenAAmount.muln(percent).divn(100);
      const adjustedB = tokenBAmount.muln(percent).divn(100);
      
      // Use the larger adjusted amount as primary input
      const useTokenA = adjustedA.gt(adjustedB);
      const inputAmount = useTokenA ? adjustedA : adjustedB;
      
      if (inputAmount.isZero()) {
        logger.warn('Adjusted amount is zero, skipping');
        continue;
      }
      
      const slippage = Percentage.fromFraction(3, 100); // 3% slippage for Token-2022
      
      // Get quote for increasing liquidity
      const quote = increaseLiquidityQuoteByInputTokenWithParams({
        inputTokenMint: useTokenA ? whirlpoolData.tokenMintA : whirlpoolData.tokenMintB,
        inputTokenAmount: inputAmount,
        tokenMintA: whirlpoolData.tokenMintA,
        tokenMintB: whirlpoolData.tokenMintB,
        tickCurrentIndex: whirlpoolData.tickCurrentIndex,
        sqrtPrice: whirlpoolData.sqrtPrice,
        tickLowerIndex: positionData.tickLowerIndex,
        tickUpperIndex: positionData.tickUpperIndex,
        slippageTolerance: slippage,
        tokenExtensionCtx: getEmptyTokenExtensionCtx() as any,
      });
      
      logger.info(`Quote generated: ${quote.liquidityAmount.toString()} liquidity, tokenA: ${quote.tokenMaxA.toString()}, tokenB: ${quote.tokenMaxB.toString()}`);
      
      const increaseTx = await position.increaseLiquidity(quote);
      const signature = await increaseTx.buildAndExecute();
      logger.info(`✓ Liquidity deposited at ${percent}%. Tx: ${signature}`);
      return true;
      
    } catch (error: any) {
      logger.warn(`Deposit at ${percent}% failed: ${error.message?.slice(0, 100)}`);
      // Continue to next percentage
    }
  }
  
  logger.error('All deposit attempts failed');
  return false;
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
