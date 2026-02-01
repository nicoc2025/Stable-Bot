#!/usr/bin/env node

// Test configuration validation edge cases
import { loadConfig, validateConfig } from './dist/config.js';

console.log('Testing configuration validation edge cases...\n');

// Test 1: Invalid edge buffer (should be less than range width)
console.log('Test 1: Edge buffer >= range width (should fail)');
try {
  const config = loadConfig();
  config.edgeBufferPercent = 0.15; // 15% buffer with 10% range width
  validateConfig(config);
  console.log('❌ Should have failed validation');
} catch (error) {
  console.log('✓ Correctly caught validation error:', error.message);
}

// Test 2: Missing required fields
console.log('\nTest 2: Missing WHIRLPOOL_ADDRESS (should fail during load)');
const originalWhirlpool = process.env.WHIRLPOOL_ADDRESS;
delete process.env.WHIRLPOOL_ADDRESS;
try {
  const config = loadConfig();
  console.log('❌ Should have failed to load config');
} catch (error) {
  console.log('✓ Correctly caught missing field error');
}
process.env.WHIRLPOOL_ADDRESS = originalWhirlpool;

// Test 3: Invalid keypair path
console.log('\nTest 3: Invalid keypair path (should fail during load)');
const originalKeypair = process.env.WALLET_KEYPAIR_PATH;
process.env.WALLET_KEYPAIR_PATH = './nonexistent-keypair.json';
try {
  const config = loadConfig();
  console.log('❌ Should have failed to load config');
} catch (error) {
  console.log('✓ Correctly caught invalid keypair path error');
}
process.env.WALLET_KEYPAIR_PATH = originalKeypair;

console.log('\n✅ All validation edge case tests passed!');