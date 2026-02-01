#!/usr/bin/env node

/**
 * Backend Test Suite for Orca LP Range Manager
 * Tests CLI commands, TypeScript compilation, and configuration validation
 */

import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { loadConfig, validateConfig } from './dist/config.js';

class OrcaLPTester {
  constructor() {
    this.testsRun = 0;
    this.testsPassed = 0;
    this.testResults = [];
  }

  runTest(name, testFn) {
    this.testsRun++;
    console.log(`\n🔍 Testing ${name}...`);
    
    try {
      testFn();
      this.testsPassed++;
      console.log(`✅ Passed - ${name}`);
      this.testResults.push({ name, status: 'PASSED', error: null });
      return true;
    } catch (error) {
      console.log(`❌ Failed - ${name}: ${error.message}`);
      this.testResults.push({ name, status: 'FAILED', error: error.message });
      return false;
    }
  }

  // Test 1: TypeScript compilation
  testTypeScriptCompilation() {
    this.runTest('TypeScript Compilation', () => {
      const output = execSync('yarn build', { cwd: '/app', encoding: 'utf8' });
      if (!existsSync('/app/dist/index.js')) {
        throw new Error('Compiled index.js not found');
      }
      if (!existsSync('/app/dist/config.js')) {
        throw new Error('Compiled config.js not found');
      }
      // Check all modules compiled
      const modules = ['auth.js', 'orca.js', 'strategy.js', 'rebalance.js', 'logger.js'];
      for (const module of modules) {
        if (!existsSync(`/app/dist/${module}`)) {
          throw new Error(`Compiled ${module} not found`);
        }
      }
    });
  }

  // Test 2: CLI --help command
  testCliHelp() {
    this.runTest('CLI --help Command', () => {
      const output = execSync('node dist/index.js --help', { cwd: '/app', encoding: 'utf8' });
      
      // Check for expected commands
      const expectedCommands = ['daemon', 'once', 'status', 'gen-keypair', 'gen-password-hash', 'setup'];
      for (const cmd of expectedCommands) {
        if (!output.includes(cmd)) {
          throw new Error(`Command '${cmd}' not found in help output`);
        }
      }
      
      // Check for version and help options
      if (!output.includes('-V, --version') || !output.includes('-h, --help')) {
        throw new Error('Version or help options not found');
      }
    });
  }

  // Test 3: gen-keypair command
  testGenKeypair() {
    this.runTest('gen-keypair Command', () => {
      const testKeypairPath = '/app/test-generated-keypair.json';
      
      // Clean up any existing test file
      if (existsSync(testKeypairPath)) {
        unlinkSync(testKeypairPath);
      }
      
      const output = execSync(`node dist/index.js gen-keypair -o ${testKeypairPath}`, { 
        cwd: '/app', 
        encoding: 'utf8' 
      });
      
      // Check file was created
      if (!existsSync(testKeypairPath)) {
        throw new Error('Keypair file was not created');
      }
      
      // Check file content is valid JSON array
      import { readFileSync } from 'fs';
      const keypairContent = JSON.parse(readFileSync(testKeypairPath, 'utf8'));
      if (!Array.isArray(keypairContent) || keypairContent.length !== 64) {
        throw new Error('Invalid keypair format - should be array of 64 bytes');
      }
      
      // Check output contains public key
      if (!output.includes('Public Key:') || !output.includes('Keypair generated successfully')) {
        throw new Error('Expected output messages not found');
      }
      
      // Clean up
      unlinkSync(testKeypairPath);
    });
  }

  // Test 4: Configuration loading and validation
  testConfigurationLoading() {
    this.runTest('Configuration Loading with Zod Validation', () => {
      // Test successful loading
      const config = loadConfig();
      
      // Verify required fields are present
      if (!config.walletKeypairPath || !config.whirlpoolAddress) {
        throw new Error('Required configuration fields missing');
      }
      
      // Verify types and defaults
      if (typeof config.rangeWidthPercent !== 'number' || config.rangeWidthPercent <= 0) {
        throw new Error('Invalid rangeWidthPercent');
      }
      
      if (typeof config.dryRun !== 'boolean') {
        throw new Error('Invalid dryRun type');
      }
      
      if (!['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
        throw new Error('Invalid logLevel');
      }
      
      // Test validation
      validateConfig(config);
    });
  }

  // Test 5: Configuration validation edge cases
  testConfigurationValidation() {
    this.runTest('Configuration Validation Edge Cases', () => {
      const config = loadConfig();
      
      // Test edge buffer validation
      const originalEdgeBuffer = config.edgeBufferPercent;
      config.edgeBufferPercent = config.rangeWidthPercent + 0.01; // Invalid: buffer > range
      
      try {
        validateConfig(config);
        throw new Error('Should have failed validation for edge buffer >= range width');
      } catch (error) {
        if (!error.message.includes('EDGE_BUFFER_PERCENT must be less than RANGE_WIDTH_PERCENT')) {
          throw new Error('Wrong validation error message');
        }
      }
      
      // Restore valid config
      config.edgeBufferPercent = originalEdgeBuffer;
      validateConfig(config); // Should pass now
    });
  }

  // Test 6: All source modules exist
  testSourceModulesExist() {
    this.runTest('All Required Source Modules Exist', () => {
      const requiredModules = [
        '/app/src/index.ts',
        '/app/src/config.ts', 
        '/app/src/auth.ts',
        '/app/src/orca.ts',
        '/app/src/strategy.ts',
        '/app/src/rebalance.ts',
        '/app/src/logger.ts'
      ];
      
      for (const module of requiredModules) {
        if (!existsSync(module)) {
          throw new Error(`Required module ${module} not found`);
        }
      }
      
      // Check package.json and tsconfig.json
      if (!existsSync('/app/package.json')) {
        throw new Error('package.json not found');
      }
      
      if (!existsSync('/app/tsconfig.json')) {
        throw new Error('tsconfig.json not found');
      }
    });
  }

  // Run all tests
  runAllTests() {
    console.log('🚀 Starting Orca LP Range Manager Backend Tests\n');
    console.log('═'.repeat(60));
    
    this.testSourceModulesExist();
    this.testTypeScriptCompilation();
    this.testCliHelp();
    this.testGenKeypair();
    this.testConfigurationLoading();
    this.testConfigurationValidation();
    
    console.log('\n' + '═'.repeat(60));
    console.log('📊 TEST RESULTS');
    console.log('═'.repeat(60));
    console.log(`Tests Run: ${this.testsRun}`);
    console.log(`Tests Passed: ${this.testsPassed}`);
    console.log(`Tests Failed: ${this.testsRun - this.testsPassed}`);
    console.log(`Success Rate: ${((this.testsPassed / this.testsRun) * 100).toFixed(1)}%`);
    
    if (this.testsPassed === this.testsRun) {
      console.log('\n🎉 ALL TESTS PASSED! The Orca LP Range Manager backend is working correctly.');
      return 0;
    } else {
      console.log('\n❌ Some tests failed. See details above.');
      console.log('\nFailed Tests:');
      this.testResults
        .filter(r => r.status === 'FAILED')
        .forEach(r => console.log(`  - ${r.name}: ${r.error}`));
      return 1;
    }
  }
}

// Run tests
const tester = new OrcaLPTester();
const exitCode = tester.runAllTests();
process.exit(exitCode);