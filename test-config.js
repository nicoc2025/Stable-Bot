#!/usr/bin/env node

// Test configuration loading and validation
import { loadConfig, validateConfig } from './dist/config.js';

console.log('Testing configuration loading and validation...\n');

try {
  console.log('1. Loading configuration from .env...');
  const config = loadConfig();
  console.log('✓ Configuration loaded successfully');
  
  console.log('\n2. Validating configuration...');
  validateConfig(config);
  console.log('✓ Configuration validation passed');
  
  console.log('\n3. Configuration summary:');
  console.log(`   - Cluster: ${config.cluster}`);
  console.log(`   - RPC URL: ${config.rpcUrl}`);
  console.log(`   - Keypair Path: ${config.walletKeypairPath}`);
  console.log(`   - Whirlpool Address: ${config.whirlpoolAddress}`);
  console.log(`   - Range Width: ${config.rangeWidthPercent * 100}%`);
  console.log(`   - Edge Buffer: ${config.edgeBufferPercent * 100}%`);
  console.log(`   - Dwell Time: ${config.dwellSeconds}s`);
  console.log(`   - Min Rebalance Interval: ${config.minRebalanceIntervalSeconds}s`);
  console.log(`   - Poll Interval: ${config.pollIntervalSeconds}s`);
  console.log(`   - Dry Run: ${config.dryRun}`);
  console.log(`   - Log Level: ${config.logLevel}`);
  
  console.log('\n✅ All configuration tests passed!');
  process.exit(0);
  
} catch (error) {
  console.error('\n❌ Configuration test failed:');
  console.error(error.message);
  process.exit(1);
}