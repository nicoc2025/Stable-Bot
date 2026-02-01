/**
 * Authentication module for Orca LP Range Manager
 * Handles username/password with bcrypt hashing
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import bcrypt from 'bcrypt';
import readlineSync from 'readline-sync';
import { getLogger } from './logger.js';

const logger = getLogger('Auth');

const AUTH_FILE_PATH = join(process.cwd(), 'data', 'auth.json');
const BCRYPT_ROUNDS = 12;

interface AuthCredentials {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Check if auth credentials exist (either in file or env vars)
 */
export function hasCredentials(envUsername?: string, envPasswordHash?: string): boolean {
  // Check env vars first
  if (envUsername && envPasswordHash) {
    return true;
  }
  
  // Check auth file
  return existsSync(AUTH_FILE_PATH);
}

/**
 * Load credentials from file
 */
function loadCredentialsFromFile(): AuthCredentials | null {
  if (!existsSync(AUTH_FILE_PATH)) {
    return null;
  }
  
  try {
    const data = readFileSync(AUTH_FILE_PATH, 'utf-8');
    return JSON.parse(data) as AuthCredentials;
  } catch (error) {
    logger.error('Failed to load auth file', error);
    return null;
  }
}

/**
 * Save credentials to file
 */
function saveCredentialsToFile(credentials: AuthCredentials): void {
  const dir = dirname(AUTH_FILE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(AUTH_FILE_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  logger.info(`Credentials saved to ${AUTH_FILE_PATH}`);
}

/**
 * First-run setup flow - prompts user to create credentials
 */
export async function setupCredentials(): Promise<void> {
  console.log('\n========================================');
  console.log('  FIRST-RUN SETUP: Create Credentials');
  console.log('========================================\n');
  
  // Get username
  const username = readlineSync.question('Enter username: ', {
    limit: /^[a-zA-Z0-9_]{3,32}$/,
    limitMessage: 'Username must be 3-32 alphanumeric characters or underscores',
  });
  
  // Get password (hidden input)
  const password = readlineSync.question('Enter password (min 8 chars): ', {
    hideEchoBack: true,
    mask: '*',
  });
  
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  
  // Confirm password
  const confirmPassword = readlineSync.question('Confirm password: ', {
    hideEchoBack: true,
    mask: '*',
  });
  
  if (password !== confirmPassword) {
    throw new Error('Passwords do not match');
  }
  
  // Hash password
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  
  // Save credentials
  const credentials: AuthCredentials = {
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  
  saveCredentialsToFile(credentials);
  
  console.log('\n✓ Credentials created successfully!\n');
}

/**
 * Authenticate user with username and password
 */
export async function authenticate(envUsername?: string, envPasswordHash?: string): Promise<boolean> {
  console.log('\n========================================');
  console.log('        AUTHENTICATION REQUIRED');
  console.log('========================================\n');
  
  // Get stored credentials
  let storedUsername: string;
  let storedPasswordHash: string;
  
  if (envUsername && envPasswordHash) {
    // Use env vars
    storedUsername = envUsername;
    storedPasswordHash = envPasswordHash;
    logger.debug('Using credentials from environment variables');
  } else {
    // Load from file
    const credentials = loadCredentialsFromFile();
    if (!credentials) {
      throw new Error('No credentials found. Run setup first.');
    }
    storedUsername = credentials.username;
    storedPasswordHash = credentials.passwordHash;
    logger.debug('Using credentials from auth file');
  }
  
  // Prompt for username
  const inputUsername = readlineSync.question('Username: ');
  
  if (inputUsername !== storedUsername) {
    logger.error('Authentication failed: Invalid username');
    return false;
  }
  
  // Prompt for password
  const inputPassword = readlineSync.question('Password: ', {
    hideEchoBack: true,
    mask: '*',
  });
  
  // Verify password
  const isValid = await bcrypt.compare(inputPassword, storedPasswordHash);
  
  if (!isValid) {
    logger.error('Authentication failed: Invalid password');
    return false;
  }
  
  logger.info('Authentication successful');
  console.log('\n✓ Authentication successful!\n');
  return true;
}

/**
 * Hash a password for env var storage
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Generate a password hash for env var usage
 */
export async function generatePasswordHash(): Promise<void> {
  console.log('\n========================================');
  console.log('      GENERATE PASSWORD HASH');
  console.log('========================================\n');
  console.log('Use this to set AUTH_PASSWORD_HASH in .env\n');
  
  const password = readlineSync.question('Enter password to hash: ', {
    hideEchoBack: true,
    mask: '*',
  });
  
  const hash = await hashPassword(password);
  
  console.log('\nGenerated hash (add to .env):');
  console.log(`AUTH_PASSWORD_HASH=${hash}\n`);
}
