/**
 * Minimal structured JSON logger. One line per event, always includes
 * a timestamp and level, and carries request/job correlation ids
 * through `.child()` so a single publish or webhook can be traced
 * across the scanner, Meta client, and queue by grepping one id.
 */

type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentThreshold(): Level {
  const fromEnv = process.env.LOG_LEVEL as Level | undefined;
  return fromEnv && fromEnv in LEVEL_ORDER ? fromEnv : "info";
}

export class Logger {
  private readonly baseFields: Fields;

  constructor(baseFields: Fields = {}) {
    this.baseFields = baseFields;
  }

  child(fields: Fields): Logger {
    return new Logger({ ...this.baseFields, ...fields });
  }

  private write(level: Level, msg: string, fields?: Fields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentThreshold()]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.baseFields,
      ...fields
    };
    const serialized = JSON.stringify(line, (_key, value) => (value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value));
    if (level === "error") {
      console.error(serialized);
    } else if (level === "warn") {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  debug(msg: string, fields?: Fields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.write("error", msg, fields);
  }
}

export const rootLogger = new Logger();

/** Generates a short correlation id for tracing one job/request through logs. */
export function newCorrelationId(prefix = "cid"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
