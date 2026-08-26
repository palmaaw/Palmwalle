/**
 * Dependency-free structured logger for Fastify with RECURSIVE REDACTION of
 * sensitive fields. Biometric descriptors (`vec`, `descriptor`), template
 * ciphertext, PINs, tokens and authorization headers must never reach logs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEY_RE = /(pin|pass|secret|token|authorization|cookie|descriptor|vec|ciphertext|template)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface PalmaLogger {
  debug(msg: string, obj?: unknown): void;
  info(msg: string, obj?: unknown): void;
  warn(msg: string, obj?: unknown): void;
  error(msg: string, obj?: unknown): void;
  child(bindings: Record<string, unknown>): PalmaLogger;
  level: LogLevel;
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): PalmaLogger {
  const min = LEVEL_ORDER[level];
  const write = (at: LogLevel, msg: string, obj?: unknown): void => {
    if (LEVEL_ORDER[at] < min) return;
    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: at,
      msg,
      ...redact(bindings) as Record<string, unknown>
    };
    if (obj !== undefined) Object.assign(line, redact(obj) as Record<string, unknown>);
    // eslint-disable-next-line no-console -- this IS the console transport
    console.log(JSON.stringify(line));
  };

  return {
    level,
    debug: (msg, obj) => write('debug', msg, obj),
    info: (msg, obj) => write('info', msg, obj),
    warn: (msg, obj) => write('warn', msg, obj),
    error: (msg, obj) => write('error', msg, obj),
    child: (extra) => createLogger(level, { ...bindings, ...redact(extra) as Record<string, unknown> })
  };
}

/** Satisfies Fastify's logger option shape minimally. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function asFastifyLogger(l: PalmaLogger): any {
  return {
    level: l.level,
    info: (o: any, m?: string) => (typeof o === 'string' ? l.info(o) : l.info(m ?? '', o)),
    warn: (o: any, m?: string) => (typeof o === 'string' ? l.warn(o) : l.warn(m ?? '', o)),
    error: (o: any, m?: string) => (typeof o === 'string' ? l.error(o) : l.error(m ?? '', o)),
    debug: (o: any, m?: string) => (typeof o === 'string' ? l.debug(o) : l.debug(m ?? '', o)),
    trace: (o: any, m?: string) => undefined,
    fatal: (o: any, m?: string) => (typeof o === 'string' ? l.error(o) : l.error(m ?? '', o)),
    child: (bindings: any) => asFastifyLogger(l.child(bindings))
  };
}
