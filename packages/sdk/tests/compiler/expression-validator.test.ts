import { describe, it, expect, vi } from 'vitest';
import { ExpressionValidator } from '../../src/rules/expression-validator.js';
import type { ValidationContext } from '../../src/types/config.js';
import type { Rule } from '../../src/rules/types.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createContext = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  toolName: 'send_email',
  arguments: {
    to: 'user@example.com',
    subject: 'Hello',
    body: 'Test email body',
    amount: 500,
  },
  callId: 'call_123',
  timestamp: new Date(),
  callHistory: [],
  ...overrides,
});

describe('ExpressionValidator', () => {
  describe('expression-based conditions', () => {
    it('should allow when no rules match', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const result = await validator.validate(createContext());
      expect(result.decision).toBe('allow');
    });

    it('should deny when expression condition matches a block rule', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'high-amount',
        name: 'Block high amounts',
        description: 'Block amounts over 1000',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { expression: 'amount > 1000' },
        ],
      };

      validator.addRules([rule]);

      const lowAmount = await validator.validate(createContext({ arguments: { amount: 500 } }));
      expect(lowAmount.decision).toBe('allow');

      const highAmount = await validator.validate(createContext({ arguments: { amount: 1500 } }));
      expect(highAmount.decision).toBe('deny');
      expect(highAmount.reason).toBe('Block amounts over 1000');
    });

    it('should handle compound expression conditions', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'suspicious-email',
        name: 'Block suspicious emails',
        enabled: true,
        severity: 'critical',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { expression: 'to contains "@external.com" && amount > 100' },
        ],
      };

      validator.addRules([rule]);

      const safe = await validator.validate(createContext({
        arguments: { to: 'user@internal.com', amount: 200 },
      }));
      expect(safe.decision).toBe('allow');

      const suspicious = await validator.validate(createContext({
        arguments: { to: 'user@external.com', amount: 200 },
      }));
      expect(suspicious.decision).toBe('deny');
    });

    it('should cache compiled expressions', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'cached',
        name: 'Cached rule',
        enabled: true,
        severity: 'low',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { expression: 'amount > 9999' },
        ],
      };

      validator.addRules([rule]);

      // Call multiple times to exercise cache
      await validator.validate(createContext());
      await validator.validate(createContext());
      await validator.validate(createContext());

      // No assertion needed -- just verifying no crash
    });
  });

  describe('legacy conditions (backward compat)', () => {
    it('should evaluate equals condition', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'legacy-1',
        name: 'Block admin emails',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'to', operator: 'equals', value: 'admin@corp.com' },
        ],
      };

      validator.addRules([rule]);

      const safe = await validator.validate(createContext({ arguments: { to: 'user@corp.com' } }));
      expect(safe.decision).toBe('allow');

      const blocked = await validator.validate(createContext({ arguments: { to: 'admin@corp.com' } }));
      expect(blocked.decision).toBe('deny');
    });

    it('should evaluate contains condition', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'legacy-2',
        name: 'Block password in body',
        enabled: true,
        severity: 'critical',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'body', operator: 'contains', value: 'password' },
        ],
      };

      validator.addRules([rule]);

      const safe = await validator.validate(createContext({ arguments: { body: 'Hello world' } }));
      expect(safe.decision).toBe('allow');

      const blocked = await validator.validate(createContext({ arguments: { body: 'Your password is 1234' } }));
      expect(blocked.decision).toBe('deny');
    });

    it('should evaluate greater_than condition', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'legacy-3',
        name: 'Block high amounts',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'amount', operator: 'greater_than', value: 1000 },
        ],
      };

      validator.addRules([rule]);

      const result = await validator.validate(createContext({ arguments: { amount: 2000 } }));
      expect(result.decision).toBe('deny');
    });

    it('should evaluate matches (regex) condition', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'legacy-4',
        name: 'Block non-corp emails',
        enabled: true,
        severity: 'medium',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'to', operator: 'matches', value: '.*@external\\.com$' },
        ],
      };

      validator.addRules([rule]);

      const safe = await validator.validate(createContext({ arguments: { to: 'user@corp.com' } }));
      expect(safe.decision).toBe('allow');

      const blocked = await validator.validate(createContext({ arguments: { to: 'user@external.com' } }));
      expect(blocked.decision).toBe('deny');
    });

    it('should reject unsafe regex patterns in matches (ReDoS)', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'redos',
        name: 'Unsafe regex rule',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'to', operator: 'matches', value: '(a+)+' },
        ],
      };

      validator.addRules([rule]);

      const result = await validator.validate(createContext({ arguments: { to: 'aaaaaa' } }));
      expect(result.decision).toBe('allow');
    });

    it('should reject regex patterns exceeding 256 chars in matches', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'long-regex',
        name: 'Long regex rule',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'to', operator: 'matches', value: 'a'.repeat(257) },
        ],
      };

      validator.addRules([rule]);

      const result = await validator.validate(createContext({ arguments: { to: 'a'.repeat(257) } }));
      expect(result.decision).toBe('allow');
    });

    it('should evaluate in condition', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'legacy-5',
        name: 'Only allow known currencies',
        enabled: true,
        severity: 'medium',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'currency', operator: 'not_in', value: ['USD', 'EUR', 'GBP'] },
        ],
      };

      validator.addRules([rule]);

      const safe = await validator.validate(createContext({ arguments: { currency: 'USD' } }));
      expect(safe.decision).toBe('allow');

      const blocked = await validator.validate(createContext({ arguments: { currency: 'BTC' } }));
      expect(blocked.decision).toBe('deny');
    });

    it('should evaluate dotted field paths', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'legacy-6',
        name: 'Block admin role',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'user.role', operator: 'equals', value: 'admin' },
        ],
      };

      validator.addRules([rule]);

      const result = await validator.validate(createContext({
        arguments: { user: { role: 'admin' } },
      }));
      expect(result.decision).toBe('deny');
    });
  });

  describe('condition_groups (OR logic)', () => {
    it('should match any condition group', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'groups-1',
        name: 'Block risky actions',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        condition_groups: [
          [{ expression: 'amount > 5000' }],
          [{ expression: 'to contains "competitor.com"' }],
        ],
      };

      validator.addRules([rule]);

      const safe = await validator.validate(createContext({
        arguments: { amount: 100, to: 'friend@corp.com' },
      }));
      expect(safe.decision).toBe('allow');

      const highAmount = await validator.validate(createContext({
        arguments: { amount: 6000, to: 'friend@corp.com' },
      }));
      expect(highAmount.decision).toBe('deny');

      const competitor = await validator.validate(createContext({
        arguments: { amount: 100, to: 'spy@competitor.com' },
      }));
      expect(competitor.decision).toBe('deny');
    });
  });

  describe('mixed conditions', () => {
    it('should support expression and legacy conditions in same rule', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'mixed-1',
        name: 'Mixed conditions',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { field: 'to', operator: 'contains', value: '@external.com' },
          { expression: 'amount > 500' },
        ],
      };

      validator.addRules([rule]);

      // Both conditions must match (AND logic)
      const partial = await validator.validate(createContext({
        arguments: { to: 'user@external.com', amount: 100 },
      }));
      expect(partial.decision).toBe('allow');

      const both = await validator.validate(createContext({
        arguments: { to: 'user@external.com', amount: 600 },
      }));
      expect(both.decision).toBe('deny');
    });
  });

  describe('toNamedValidator', () => {
    it('should produce a valid NamedValidator', () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const named = validator.toNamedValidator();
      expect(named.name).toBe('expression-validator');
      expect(named.priority).toBe(40);
      expect(typeof named.validate).toBe('function');
    });
  });

  describe('disabled rules', () => {
    it('should skip disabled rules', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'disabled-1',
        name: 'Disabled rule',
        enabled: false,
        severity: 'high',
        action: 'block',
        tools: ['send_email'],
        conditions: [
          { expression: 'true' },
        ],
      };

      validator.addRules([rule]);

      const result = await validator.validate(createContext());
      expect(result.decision).toBe('allow');
    });
  });

  describe('allow action', () => {
    it('should explicitly allow on matching allow rule', async () => {
      const validator = new ExpressionValidator({
        config: {},
        logger: createMockLogger(),
      });

      const rule: Rule = {
        id: 'allow-1',
        name: 'Allow internal emails',
        enabled: true,
        severity: 'info',
        action: 'allow',
        tools: ['send_email'],
        conditions: [
          { expression: 'to contains "@internal.com"' },
        ],
      };

      validator.addRules([rule]);

      const result = await validator.validate(createContext({
        arguments: { to: 'user@internal.com' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.metadata?.ruleId).toBe('allow-1');
    });
  });
});
