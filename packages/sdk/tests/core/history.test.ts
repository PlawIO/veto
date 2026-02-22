import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HistoryTracker } from '../../src/core/history.js';
import type { ToolCallHistoryEntry } from '../../src/types/config.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('HistoryTracker', () => {
  let tracker: HistoryTracker;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    tracker = new HistoryTracker({ maxSize: 5, logger: mockLogger });
  });

  describe('add and record', () => {
    it('should add entries to history', () => {
      const entry: ToolCallHistoryEntry = {
        toolName: 'read_file',
        arguments: { path: '/test' },
        validationResult: { decision: 'allow' },
        timestamp: new Date(),
      };

      tracker.add(entry);

      expect(tracker.size()).toBe(1);
      expect(tracker.getAll()).toHaveLength(1);
      expect(tracker.getAll()[0].toolName).toBe('read_file');
    });

    it('should record tool calls with convenience method', () => {
      tracker.record(
        'write_file',
        { path: '/test', content: 'hello' },
        { decision: 'allow' },
        100
      );

      expect(tracker.size()).toBe(1);
      const entries = tracker.getAll();
      expect(entries[0].toolName).toBe('write_file');
      expect(entries[0].durationMs).toBe(100);
    });

    it('should store an immutable snapshot of arguments', () => {
      const args: Record<string, unknown> = {
        nested: { state: 'before' },
      };

      tracker.record('write_file', args, { decision: 'allow' });
      (args.nested as { state: string }).state = 'after';

      const entries = tracker.getAll();
      expect(entries[0].arguments).toEqual({
        nested: { state: 'before' },
      });
    });

    it('should evict oldest entries when maxSize exceeded', () => {
      for (let i = 0; i < 7; i++) {
        tracker.record(`tool_${i}`, {}, { decision: 'allow' });
      }

      expect(tracker.size()).toBe(5);
      const entries = tracker.getAll();
      expect(entries[0].toolName).toBe('tool_2'); // First two evicted
      expect(entries[4].toolName).toBe('tool_6');
    });
  });

  describe('getAll', () => {
    it('should return frozen copy', () => {
      tracker.record('test', {}, { decision: 'allow' });

      const entries = tracker.getAll();

      expect(Object.isFrozen(entries)).toBe(true);
    });

    it('should return empty array when no entries', () => {
      expect(tracker.getAll()).toHaveLength(0);
    });
  });

  describe('getLast', () => {
    it('should return last N entries', () => {
      for (let i = 0; i < 5; i++) {
        tracker.record(`tool_${i}`, {}, { decision: 'allow' });
      }

      const last2 = tracker.getLast(2);

      expect(last2).toHaveLength(2);
      expect(last2[0].toolName).toBe('tool_3');
      expect(last2[1].toolName).toBe('tool_4');
    });

    it('should return all entries if count exceeds size', () => {
      tracker.record('tool_1', {}, { decision: 'allow' });

      const last = tracker.getLast(10);

      expect(last).toHaveLength(1);
    });
  });

  describe('getByTool', () => {
    it('should filter by tool name', () => {
      tracker.record('read_file', { path: '/a' }, { decision: 'allow' });
      tracker.record('write_file', { path: '/b' }, { decision: 'allow' });
      tracker.record('read_file', { path: '/c' }, { decision: 'deny' });

      const readEntries = tracker.getByTool('read_file');

      expect(readEntries).toHaveLength(2);
      expect(readEntries[0].arguments).toEqual({ path: '/a' });
      expect(readEntries[1].arguments).toEqual({ path: '/c' });
    });

    it('should return empty array for unknown tool', () => {
      tracker.record('read_file', {}, { decision: 'allow' });

      expect(tracker.getByTool('unknown')).toHaveLength(0);
    });
  });

  describe('getByTimeRange', () => {
    it('should filter by time range', () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      // Add entry from 2 hours ago
      tracker.add({
        toolName: 'old_call',
        arguments: {},
        validationResult: { decision: 'allow' },
        timestamp: twoHoursAgo,
      });

      // Add entry from 30 mins ago
      const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);
      tracker.add({
        toolName: 'recent_call',
        arguments: {},
        validationResult: { decision: 'allow' },
        timestamp: thirtyMinsAgo,
      });

      const lastHour = tracker.getByTimeRange(hourAgo);

      expect(lastHour).toHaveLength(1);
      expect(lastHour[0].toolName).toBe('recent_call');
    });
  });

  describe('getDenied', () => {
    it('should return only denied entries', () => {
      tracker.record('tool_a', {}, { decision: 'allow' });
      tracker.record('tool_b', {}, { decision: 'deny', reason: 'blocked' });
      tracker.record('tool_c', {}, { decision: 'allow' });
      tracker.record('tool_d', {}, { decision: 'deny', reason: 'blocked' });

      const denied = tracker.getDenied();

      expect(denied).toHaveLength(2);
      expect(denied[0].toolName).toBe('tool_b');
      expect(denied[1].toolName).toBe('tool_d');
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      tracker.record('tool_1', {}, { decision: 'allow' });
      tracker.record('tool_2', {}, { decision: 'allow' });

      tracker.clear();

      expect(tracker.size()).toBe(0);
      expect(tracker.getAll()).toHaveLength(0);
    });
  });

  describe('exportDecisions', () => {
    it('should export decisions as JSON with required fields', () => {
      tracker.record('wire_transfer', {
        amount: 12500,
        recipient: 'ops-vendor',
      }, {
        decision: 'deny',
        reason: 'Approval denied',
        metadata: {
          ruleId: 'require-wire-approval',
          policyVersion: '1.0',
        },
      });

      const raw = tracker.exportDecisions('json');
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        tool_name: 'wire_transfer',
        arguments: { amount: 12500, recipient: 'ops-vendor' },
        policy_version: '1.0',
        rule_id: 'require-wire-approval',
        decision: 'deny',
        reason: 'Approval denied',
      });
      expect(typeof parsed[0].timestamp).toBe('string');
    });

    it('should export decisions as CSV', () => {
      tracker.record('wire_transfer', {
        note: 'requires, review',
      }, {
        decision: 'allow',
        metadata: {
          rule_id: 'require-wire-approval',
          policy_version: '1.0',
        },
      });

      const csv = tracker.exportDecisions('csv');
      const lines = csv.split('\n');

      expect(lines[0]).toBe('timestamp,tool_name,arguments,policy_version,rule_id,decision,reason');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('wire_transfer');
      expect(lines[1]).toContain('require-wire-approval');
      expect(lines[1]).toContain('allow');
    });

    it('should reject unsupported export formats', () => {
      expect(() => tracker.exportDecisions('xml' as never)).toThrow(
        'Unsupported decision export format'
      );
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      tracker.record('read_file', {}, { decision: 'allow' });
      tracker.record('read_file', {}, { decision: 'allow' });
      tracker.record('write_file', {}, { decision: 'deny' });
      tracker.record('execute', {}, { decision: 'modify', modifiedArguments: {} });

      const stats = tracker.getStats();

      expect(stats.totalCalls).toBe(4);
      expect(stats.allowedCalls).toBe(2);
      expect(stats.deniedCalls).toBe(1);
      expect(stats.modifiedCalls).toBe(1);
      expect(stats.callsByTool).toEqual({
        read_file: 2,
        write_file: 1,
        execute: 1,
      });
    });

    it('should return zeros for empty history', () => {
      const stats = tracker.getStats();

      expect(stats.totalCalls).toBe(0);
      expect(stats.allowedCalls).toBe(0);
      expect(stats.deniedCalls).toBe(0);
      expect(stats.modifiedCalls).toBe(0);
      expect(stats.callsByTool).toEqual({});
    });
  });
});
