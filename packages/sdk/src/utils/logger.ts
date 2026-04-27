/**
 * Logging infrastructure for Veto.
 *
 * Provides a flexible logging system with configurable log levels
 * and support for custom logger implementations.
 *
 * @module utils/logger
 */

import type { LogLevel, StreamLogMode } from '../types/config.js';

/**
 * Log entry structure for structured logging.
 */
export interface LogEntry {
  /** Log level of this entry */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Timestamp of the log entry */
  timestamp: Date;
  /** Additional context data */
  context?: Record<string, unknown>;
  /** Error object if applicable */
  error?: Error;
}

/**
 * Structured payload for one-line tool decision stream output.
 */
export interface DecisionStreamEvent {
  decision: 'allow' | 'deny' | 'await';
  toolName: string;
  arguments?: Record<string, unknown>;
  reason?: string;
  ruleId?: string;
  latencyMs?: number;
  approvalId?: string;
  /** Email or identifier of the approver that resolved an awaited decision. */
  approver?: string;
  /** Override for the timestamp shown in compact mode (defaults to "now"). */
  timestamp?: Date;
}

/**
 * Logger interface that can be implemented for custom logging.
 *
 * @example
 * ```typescript
 * const customLogger: Logger = {
 *   debug: (msg, ctx) => myLoggingService.log('debug', msg, ctx),
 *   info: (msg, ctx) => myLoggingService.log('info', msg, ctx),
 *   warn: (msg, ctx) => myLoggingService.log('warn', msg, ctx),
 *   error: (msg, ctx, err) => myLoggingService.log('error', msg, { ...ctx, err }),
 * };
 * ```
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

export interface DecisionStreamLogger extends Logger {
  streamDecision(event: DecisionStreamEvent): void;
}

/**
 * Base class for stream-mode decision loggers.
 *
 * External code (the validation engine, integrations, etc.) detects stream
 * mode via `instanceof BaseStreamLogger`. Inheriting from this class is the
 * explicit opt-in — duck-typing on the `streamDecision` method name is
 * intentionally avoided so user loggers that happen to expose the same name
 * are not silently misidentified.
 */
export abstract class BaseStreamLogger implements DecisionStreamLogger {
  abstract debug(message: string, context?: Record<string, unknown>): void;
  abstract info(message: string, context?: Record<string, unknown>): void;
  abstract warn(message: string, context?: Record<string, unknown>): void;
  abstract error(message: string, context?: Record<string, unknown>, error?: Error): void;
  abstract streamDecision(event: DecisionStreamEvent): void;
}

/**
 * Numeric priority for log levels (lower = more verbose).
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  stream: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const ANSI_RESET = '\u001B[0m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const ANSI_DIM = '\u001B[2m';
const ANSI_BOLD = '\u001B[1m';

/**
 * Check if a log level should be emitted given the configured level.
 */
function shouldLog(messageLevel: Exclude<LogLevel, 'stream'>, configuredLevel: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[messageLevel] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Strip C0/C1 control characters and explicitly visualise newlines/tabs in
// user-supplied strings before they hit the terminal. Keeps the
// one-line-per-decision invariant intact and prevents user data from
// spoofing terminal state via embedded ANSI escapes.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

function sanitizeStr(value: string): string {
  return value
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(CONTROL_CHARS, '');
}

function escapeString(value: string): string {
  return sanitizeStr(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    return `'${escapeString(value)}'`;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
    }
    return String(value);
  }

  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value === null) {
    return 'null';
  }

  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }

  if (typeof value === 'undefined') {
    return 'undefined';
  }

  return sanitizeStr(String(value));
}

function formatValue(value: unknown, depth = 0): string {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || typeof value === 'undefined'
    || value instanceof Date
  ) {
    return formatScalar(value);
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return '[…]';
    }

    return `[${value.map((item) => formatValue(item, depth + 1)).join(', ')}]`;
  }

  if (isPlainObject(value)) {
    if (depth >= 2) {
      return '{…}';
    }

    return `{${Object.entries(value)
      .map(([key, item]) => `${key}: ${formatValue(item, depth + 1)}`)
      .join(', ')}}`;
  }

  return formatScalar(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * JS-object-literal arg rendering: `{key: 'value', n: 1}`. Single canonical
 * formatter shared by compact + verbose modes. `empty` chooses what's
 * rendered when there are no args: compact uses `'{}'`, verbose uses `''`.
 */
function formatArgsInline(
  args: Record<string, unknown> | undefined,
  options: { maxLength: number; empty?: string }
): string {
  if (!args || Object.keys(args).length === 0) {
    return options.empty ?? '';
  }
  return truncate(formatValue(args), options.maxLength);
}

function formatDuration(latencyMs?: number): string | null {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return null;
  }

  return `${Math.round(latencyMs)}ms`;
}

/**
 * Compact latency cell for the decision stream. Auto-scales: ms → s → m → h.
 * Returns "-" when there's no measured latency (e.g. an `await` decision that
 * hasn't resolved yet).
 */
function formatLatencyCell(latencyMs?: number): string {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return '-';
  }
  if (latencyMs < 1_000) return `${Math.round(latencyMs)}ms`;
  if (latencyMs < 60_000) return `${Math.round(latencyMs / 1_000)}s`;
  if (latencyMs < 3_600_000) return `${Math.round(latencyMs / 60_000)}m`;
  return `${Math.round(latencyMs / 3_600_000)}h`;
}

/**
 * HH:MM:SS in UTC by default; set `VETO_LOG_LOCALTIME=1` for host time.
 *
 * UTC is the default so the same code prints the same row on a developer's
 * laptop, in CI, and inside a container — important for diffing logs.
 */
function formatTimeOfDay(date: Date = new Date()): string {
  const localTime =
    typeof process !== 'undefined' && Boolean(process.env?.VETO_LOG_LOCALTIME);
  const hh = String(localTime ? date.getHours() : date.getUTCHours()).padStart(2, '0');
  const mm = String(localTime ? date.getMinutes() : date.getUTCMinutes()).padStart(2, '0');
  const ss = String(localTime ? date.getSeconds() : date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Trailing context tag for the compact stream:
 *   deny  → `policy:<ruleId>` when known
 *   await → `approval-required[:<approvalId>]`
 *   allow → `approved[:<approver>]` when the result came from an approval
 */
function formatTrailingTag(event: DecisionStreamEvent): string | null {
  if (event.decision === 'deny' && event.ruleId) {
    return `policy:${event.ruleId}`;
  }
  if (event.decision === 'await') {
    return event.approvalId ? `approval-required:${event.approvalId}` : 'approval-required';
  }
  if (event.decision === 'allow' && event.approver) {
    return `approved:${event.approver}`;
  }
  return null;
}

/**
 * Honor https://no-color.org and https://force-color.org conventions.
 *
 * - `NO_COLOR` set to any non-empty value → never emit ANSI.
 * - `FORCE_COLOR` set to any non-empty value → always emit ANSI.
 * - Otherwise → only emit ANSI when stderr is a TTY.
 */
function supportsColor(): boolean {
  if (typeof process === 'undefined') return false;
  if (process.env?.NO_COLOR) return false;
  if (process.env?.FORCE_COLOR) return true;
  return Boolean(process.stderr?.isTTY);
}

function colorize(value: string, color: string): string {
  if (!supportsColor()) {
    return value;
  }

  return `${color}${value}${ANSI_RESET}`;
}

function dim(value: string): string {
  if (!supportsColor()) {
    return value;
  }

  return `${ANSI_DIM}${value}${ANSI_RESET}`;
}

function bold(value: string): string {
  if (!supportsColor()) {
    return value;
  }

  return `${ANSI_BOLD}${value}${ANSI_RESET}`;
}

/** Lowercase decision keyword, padded right to 5 chars, then colorized. */
function getDecisionLabel(decision: DecisionStreamEvent['decision']): string {
  const padded = decision.padEnd(5, ' ');
  switch (decision) {
    case 'allow':
      return colorize(padded, ANSI_GREEN);
    case 'deny':
      return colorize(padded, ANSI_RED);
    case 'await':
      return colorize(padded, ANSI_YELLOW);
  }
}

function formatDecisionReason(reason: string | undefined, maxLength: number): string | null {
  if (!reason || reason.trim().length === 0) {
    return null;
  }

  return truncate(reason.trim(), maxLength);
}

const COMPACT_CALL_MIN_WIDTH = 40;
const COMPACT_CALL_MAX_WIDTH = 80;
const COMPACT_LATENCY_WIDTH = 5;
const COMPACT_ARGS_BUDGET = 60;
const VERBOSE_ARGS_MAX = 320;

/**
 * One-line decision row, formatted as:
 *   `HH:MM:SS <decision> <tool>(<args>)              <latency>  <tag?>`
 *
 * Tool name and args are sanitized (no newlines / control chars) and the
 * full call portion is hard-truncated to `COMPACT_CALL_MAX_WIDTH` so the
 * latency column stays roughly aligned across rows.
 */
function formatCompactDecision(event: DecisionStreamEvent): string {
  const time = dim(formatTimeOfDay(event.timestamp));
  const label = getDecisionLabel(event.decision);
  const safeTool = sanitizeStr(event.toolName);
  const argString = formatArgsInline(event.arguments, { maxLength: COMPACT_ARGS_BUDGET, empty: '{}' });
  const call = truncate(`${safeTool}(${argString})`, COMPACT_CALL_MAX_WIDTH);
  const callPadded = call.padEnd(COMPACT_CALL_MIN_WIDTH, ' ');
  const latency = formatLatencyCell(event.latencyMs).padStart(COMPACT_LATENCY_WIDTH, ' ');
  const tag = formatTrailingTag(event);
  const tagSuffix = tag ? `  ${dim(tag)}` : '';
  return `${time} ${label}  ${callPadded}  ${latency}${tagSuffix}`;
}

function formatVerboseDecision(event: DecisionStreamEvent): string {
  const args = formatArgsInline(event.arguments, { maxLength: VERBOSE_ARGS_MAX });
  const duration = formatDuration(event.latencyMs);
  const reason = formatDecisionReason(event.reason, VERBOSE_ARGS_MAX) ?? 'n/a';
  const lines = [
    `${bold('VETO DECISION')} ${getDecisionLabel(event.decision).trimEnd()}`,
    `time: ${formatTimeOfDay(event.timestamp)}`,
    `tool: ${sanitizeStr(event.toolName)}`,
    `args: ${args.length > 0 ? args : '(none)'}`,
    `reason: ${reason}`,
  ];

  if (event.ruleId) {
    lines.push(`rule: ${event.ruleId}`);
  }

  if (event.approvalId) {
    lines.push(`approval: ${event.approvalId}`);
  }

  if (event.approver) {
    lines.push(`approver: ${event.approver}`);
  }

  if (duration) {
    lines.push(`latency: ${duration}`);
  }

  return lines.join('\n');
}

function writeToStderr(message: string): void {
  if (typeof process !== 'undefined' && typeof process.stderr?.write === 'function') {
    process.stderr.write(`${message}\n`);
    return;
  }

  console.log(message);
}

/**
 * Format a log message with optional context.
 */
function formatMessage(
  level: Exclude<LogLevel, 'stream'>,
  message: string,
  context?: Record<string, unknown>
): string {
  const timestamp = new Date().toISOString();
  const levelStr = level.toUpperCase().padEnd(5);
  const prefix = `[${timestamp}] [VETO] ${levelStr}`;

  if (context && Object.keys(context).length > 0) {
    const contextStr = JSON.stringify(context);
    return `${prefix} ${message} ${contextStr}`;
  }

  return `${prefix} ${message}`;
}

class ConsoleLogger implements Logger {
  constructor(private readonly level: Exclude<LogLevel, 'stream'>) {}

  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('debug', this.level)) {
      console.debug(formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('info', this.level)) {
      console.info(formatMessage('info', message, context));
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog('warn', this.level)) {
      console.warn(formatMessage('warn', message, context));
    }
  }

  error(message: string, context?: Record<string, unknown>, error?: Error): void {
    if (shouldLog('error', this.level)) {
      console.error(formatMessage('error', message, context));
      if (error) {
        console.error(error);
      }
    }
  }
}

// Warn-level messages whose body the stream row already conveys. The
// StreamLogger drops these locally so callers no longer need to know about
// logger types — the validation engine just emits as before.
const STREAM_NOISY_WARNS = new Set<string>([
  'Tool call blocked by local rule',
  'Tool call blocked by local approval rule (no approval flow configured)',
]);

export class StreamLogger extends BaseStreamLogger {
  constructor(private readonly mode: StreamLogMode = 'compact') {
    super();
  }

  debug(): void {}

  info(): void {}

  warn(message: string, context?: Record<string, unknown>): void {
    // Suppress warnings that just duplicate the deny / await stream row —
    // filtering here keeps the noise off the user's terminal without the
    // validation engine having to know it's running in stream mode.
    if (STREAM_NOISY_WARNS.has(message)) return;
    writeToStderr(formatMessage('warn', message, context));
  }

  error(message: string, context?: Record<string, unknown>, error?: Error): void {
    writeToStderr(formatMessage('error', message, context));
    if (error) {
      writeToStderr(error.stack ?? error.message);
    }
  }

  streamDecision(event: DecisionStreamEvent): void {
    writeToStderr(
      this.mode === 'verbose'
        ? formatVerboseDecision(event)
        : formatCompactDecision(event)
    );
  }
}

/**
 * Detect stream-mode loggers safely.
 *
 * Strict `instanceof` check against `BaseStreamLogger`. Older code duck-typed
 * on the `streamDecision` attribute, which silently misidentified user
 * loggers that happened to expose the same method name.
 */
export function isDecisionStreamLogger(logger: Logger): logger is DecisionStreamLogger {
  return logger instanceof BaseStreamLogger;
}

/**
 * Create a console-based logger with the specified log level.
 *
 * @param level - Minimum log level to emit
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger('info');
 * logger.debug('This will not be logged');
 * logger.info('This will be logged');
 * ```
 */
export function createLogger(level: LogLevel, streamMode: StreamLogMode = 'compact'): Logger {
  if (level === 'stream') {
    return new StreamLogger(streamMode);
  }

  return new ConsoleLogger(level);
}

/**
 * A no-op logger that discards all messages.
 * Useful for testing or when logging should be completely disabled.
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Create a logger that stores entries in memory.
 * Useful for testing or capturing logs for later analysis.
 *
 * @param level - Minimum log level to capture
 * @returns Object containing the logger and captured entries
 *
 * @example
 * ```typescript
 * const { logger, entries } = createMemoryLogger('debug');
 * logger.info('test message', { key: 'value' });
 * console.log(entries); // [{ level: 'info', message: 'test message', ... }]
 * ```
 */
export function createMemoryLogger(level: LogLevel = 'debug'): {
  logger: Logger;
  entries: LogEntry[];
  clear: () => void;
} {
  const entries: LogEntry[] = [];

  const addEntry = (
    messageLevel: Exclude<LogLevel, 'stream'>,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void => {
    if (shouldLog(messageLevel, level)) {
      entries.push({
        level: messageLevel,
        message,
        timestamp: new Date(),
        context,
        error,
      });
    }
  };

  return {
    entries,
    clear: () => {
      entries.length = 0;
    },
    logger: {
      debug: (message, context) => addEntry('debug', message, context),
      info: (message, context) => addEntry('info', message, context),
      warn: (message, context) => addEntry('warn', message, context),
      error: (message, context, error) =>
        addEntry('error', message, context, error),
    },
  };
}

/**
 * Create a child logger with additional default context.
 *
 * @param parent - Parent logger to wrap
 * @param defaultContext - Context to include in all log entries
 * @returns Logger with merged context
 *
 * @example
 * ```typescript
 * const parentLogger = createLogger('info');
 * const childLogger = createChildLogger(parentLogger, { component: 'validator' });
 * childLogger.info('Validation complete'); // Includes { component: 'validator' }
 * ```
 */
export function createChildLogger(
  parent: Logger,
  defaultContext: Record<string, unknown>
): Logger {
  const mergeContext = (
    context?: Record<string, unknown>
  ): Record<string, unknown> => {
    return { ...defaultContext, ...context };
  };

  return {
    debug: (message, context) => parent.debug(message, mergeContext(context)),
    info: (message, context) => parent.info(message, mergeContext(context)),
    warn: (message, context) => parent.warn(message, mergeContext(context)),
    error: (message, context, error) =>
      parent.error(message, mergeContext(context), error),
  };
}

export {
  formatCompactDecision,
  formatMessage,
  formatVerboseDecision,
  shouldLog,
};
