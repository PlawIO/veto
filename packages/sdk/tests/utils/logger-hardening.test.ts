/**
 * Regression tests for stream logger hardening (audit follow-up).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BaseStreamLogger,
  StreamLogger,
  isDecisionStreamLogger,
  type DecisionStreamEvent,
} from '../../src/utils/logger.js';

const TS = new Date(Date.UTC(2026, 3, 27, 12, 0, 0));

// Build the ANSI-stripping regex via RegExp() so the eslint
// `no-control-regex` rule doesn't trip on a literal control char.
const ESC = String.fromCharCode(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[\\d+m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

function row(extra: Partial<DecisionStreamEvent> = {}): string {
  const sl = new StreamLogger('compact');
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    writes.push(String(chunk));
    return true;
  });
  sl.streamDecision({
    decision: 'allow',
    toolName: 't',
    arguments: { a: 1 },
    latencyMs: 1,
    timestamp: TS,
    ...extra,
  });
  spy.mockRestore();
  return writes.join('');
}

describe('logger hardening', () => {
  describe('sanitization', () => {
    it('does not allow newline in args to break the one-line invariant', () => {
      const out = row({ arguments: { q: 'line1\nline2' } });
      expect(out.split('\n').filter((s) => s.length > 0)).toHaveLength(1);
      expect(out).toContain('\\n');
    });

    it('does not allow newline in tool name to break the row', () => {
      const out = row({ toolName: 'bad\ntool' });
      expect(out.split('\n').filter((s) => s.length > 0)).toHaveLength(1);
    });

    it('strips ANSI escapes from user-supplied arg values', () => {
      const userAnsi = `${ESC}[31mred${ESC}[0m`;
      const out = row({ arguments: { x: userAnsi } });
      expect(out).not.toContain(`${ESC}[31m`);
      expect(out).toContain('red');
    });
  });

  describe('latency edge cases', () => {
    it.each([
      [NaN, '-'],
      [Infinity, '-'],
      [-Infinity, '-'],
      [-1, '-'],
    ])('non-finite/negative latency %s renders as %s', (latency, expected) => {
      expect(stripAnsi(row({ latencyMs: latency }))).toContain(expected);
    });

    it('0 ms renders as 0ms', () => {
      expect(stripAnsi(row({ latencyMs: 0 }))).toContain('0ms');
    });
  });

  describe('NO_COLOR / FORCE_COLOR', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
      process.env = { ...originalEnv };
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
    });

    it('NO_COLOR disables ANSI', () => {
      process.env.NO_COLOR = '1';
      expect(row()).not.toContain(ESC);
    });

    it('FORCE_COLOR enables ANSI', () => {
      process.env.FORCE_COLOR = '1';
      expect(row()).toContain(ESC);
    });

    it('NO_COLOR wins over FORCE_COLOR', () => {
      process.env.NO_COLOR = '1';
      process.env.FORCE_COLOR = '1';
      expect(row()).not.toContain(ESC);
    });
  });

  describe('UTC by default', () => {
    it('renders timestamp in UTC, ignoring host TZ', () => {
      const ts = new Date(Date.UTC(2026, 3, 27, 17, 30, 5));
      expect(stripAnsi(row({ timestamp: ts }))).toContain('17:30:05');
    });
  });

  describe('strict stream-logger detection (no duck-typing)', () => {
    it('does not misidentify a user logger that happens to have streamDecision', () => {
      const userLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        streamDecision: () => {},
      };
      expect(isDecisionStreamLogger(userLogger as any)).toBe(false);
    });

    it('detects an actual StreamLogger', () => {
      expect(isDecisionStreamLogger(new StreamLogger())).toBe(true);
    });

    it('detects an explicit subclass', () => {
      class CustomStream extends BaseStreamLogger {
        debug() {}
        info() {}
        warn() {}
        error() {}
        streamDecision() {}
      }
      expect(isDecisionStreamLogger(new CustomStream())).toBe(true);
    });
  });

  describe('filter-at-source: noisy warns', () => {
    it('suppresses the duplicative "Tool call blocked by local rule" warn', () => {
      const sl = new StreamLogger();
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
      sl.warn('Tool call blocked by local rule', { x: 1 });
      spy.mockRestore();
      expect(writes.join('')).toBe('');
    });

    it('still emits unrelated warns', () => {
      const sl = new StreamLogger();
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
      sl.warn('Veto config not found', { path: '/x' });
      spy.mockRestore();
      expect(writes.join('')).toContain('Veto config not found');
    });
  });
});
