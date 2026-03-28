export type LogLevel = "debug" | "info" | "warn" | "error";

function shouldLog(level: LogLevel, current: LogLevel): boolean {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return order[level] >= order[current];
}

export class Logger {
  constructor(private readonly scope: string, private readonly level: LogLevel = "info") {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level);
  }

  debug(message: string, ...args: unknown[]): void {
    if (shouldLog("debug", this.level)) console.debug(`[${this.scope}] ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (shouldLog("info", this.level)) console.info(`[${this.scope}] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog("warn", this.level)) console.warn(`[${this.scope}] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    if (shouldLog("error", this.level)) console.error(`[${this.scope}] ${message}`, ...args);
  }
}
