/**
 * Logger module for Orca LP Range Manager
 * Provides structured logging with levels and timestamps
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private level: LogLevel = 'info';
  private readonly name: string;

  constructor(name: string = 'OrcaLP') {
    this.name = name;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase().padEnd(5);
    const prefix = `[${timestamp}] [${levelTag}] [${this.name}]`;
    
    if (data !== undefined) {
      const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      return `${prefix} ${message}\n${dataStr}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, data));
    }
  }

  // Strategy-specific logging methods
  edgeHit(side: 'lower' | 'upper', currentPrice: number, boundary: number): void {
    this.warn(`EDGE HIT: Price approaching ${side} boundary`, {
      currentPrice,
      boundary,
      side,
    });
  }

  dwellStarted(reason: string, durationSeconds: number): void {
    this.info(`DWELL STARTED: ${reason} - waiting ${durationSeconds}s`, {
      reason,
      durationSeconds,
      startedAt: new Date().toISOString(),
    });
  }

  dwellReset(reason: string): void {
    this.info(`DWELL RESET: Condition no longer met - ${reason}`, {
      reason,
      resetAt: new Date().toISOString(),
    });
  }

  rebalanceExecuted(details: {
    oldLowerTick: number;
    oldUpperTick: number;
    newLowerTick: number;
    newUpperTick: number;
    newCenterPrice: number;
    feesCollected?: { tokenA: string; tokenB: string };
    txSignatures?: string[];
  }): void {
    this.info(`REBALANCE EXECUTED: Position migrated to new range`, details);
  }

  rebalanceSkipped(reason: string): void {
    this.debug(`REBALANCE SKIPPED: ${reason}`);
  }

  outOfRange(currentPrice: number, lowerBound: number, upperBound: number): void {
    this.warn(`OUT OF RANGE: Current price outside position bounds`, {
      currentPrice,
      lowerBound,
      upperBound,
    });
  }

  positionStatus(details: {
    inRange: boolean;
    currentPrice: number;
    lowerBound: number;
    upperBound: number;
    liquidity: string;
  }): void {
    this.info(`POSITION STATUS`, details);
  }
}

// Singleton instance
let loggerInstance: Logger | null = null;

export function getLogger(name?: string): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger(name);
  }
  return loggerInstance;
}

export function createLogger(name: string): Logger {
  return new Logger(name);
}
