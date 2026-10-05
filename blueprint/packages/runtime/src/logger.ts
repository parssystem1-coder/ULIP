/**
 * Minimal structured logger (Phase 14). One JSON line per event so any log
 * shipper can parse it; request-id travels in every line via `bind()`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly level: LogLevel;
  private readonly base: LogFields;
  private readonly sink: (line: string) => void;

  constructor(
    level: LogLevel,
    base: LogFields = {},
    sink: (line: string) => void = (l) => console.log(l),
  ) {
    this.level = level;
    this.base = base;
    this.sink = sink;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...this.base,
      ...fields,
    };
    this.sink(JSON.stringify(record));
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  /** Child logger with bound fields (e.g. requestId, tenantId). */
  bind(fields: LogFields): Logger {
    return new Logger(this.level, { ...this.base, ...fields }, this.sink);
  }
}
