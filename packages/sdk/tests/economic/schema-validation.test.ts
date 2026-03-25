import { describe, it, expect } from 'vitest';
import { validatePolicyIR } from '../../src/rules/schema-validator.js';

describe('Economic Policy IR Schema Validation', () => {
  it('should accept a valid economic policy', () => {
    const policy = {
      version: '1.0',
      rules: [],
      economic: {
        budgets: [
          {
            scope: 'session',
            limit: 100,
            currency: 'USD',
            approval_threshold: 25,
            window: 'session',
          },
        ],
        cost_extraction: {
          default: 'arguments.cost',
          overrides: {
            search_api: 'arguments.price_usd',
          },
        },
        payer: {
          required: true,
          approved: ['wallet_0x123'],
        },
        denial_reasons: {
          budget_exceeded: 'Would exceed budget',
          approval_required: 'Approval needed',
        },
      },
    };
    expect(() => validatePolicyIR(policy)).not.toThrow();
  });

  it('should accept economic-only policy (no rules)', () => {
    const policy = {
      version: '1.0',
      economic: {
        budgets: [
          {
            scope: 'session',
            limit: 50,
            currency: 'USD',
            window: 'session',
          },
        ],
      },
    };
    expect(() => validatePolicyIR(policy)).not.toThrow();
  });

  it('should accept policy with rules AND economic section', () => {
    const policy = {
      version: '1.0',
      rules: [
        {
          id: 'test-rule',
          name: 'Test Rule',
          action: 'allow',
        },
      ],
      economic: {
        budgets: [
          {
            scope: 'session',
            limit: 100,
            currency: 'USD',
            window: 'session',
          },
        ],
      },
    };
    expect(() => validatePolicyIR(policy)).not.toThrow();
  });

  it('should reject invalid budget scope', () => {
    const policy = {
      version: '1.0',
      economic: {
        budgets: [
          {
            scope: 'invalid_scope',
            limit: 100,
            currency: 'USD',
            window: 'session',
          },
        ],
      },
    };
    expect(() => validatePolicyIR(policy)).toThrow();
  });

  it('should reject negative budget limit', () => {
    const policy = {
      version: '1.0',
      economic: {
        budgets: [
          {
            scope: 'session',
            limit: -10,
            currency: 'USD',
            window: 'session',
          },
        ],
      },
    };
    expect(() => validatePolicyIR(policy)).toThrow();
  });

  it('should reject unknown denial reason keys', () => {
    const policy = {
      version: '1.0',
      economic: {
        budgets: [
          { scope: 'session', limit: 100, currency: 'USD', window: 'session' },
        ],
        denial_reasons: {
          budget_exceeded: 'valid',
          made_up_reason: 'invalid',
        },
      },
    };
    expect(() => validatePolicyIR(policy)).toThrow();
  });

  it('should accept all valid budget scopes', () => {
    for (const scope of ['session', 'agent', 'user', 'global']) {
      const policy = {
        version: '1.0',
        economic: {
          budgets: [
            { scope, limit: 100, currency: 'USD', window: 'session' },
          ],
        },
      };
      expect(() => validatePolicyIR(policy)).not.toThrow();
    }
  });

  it('should accept economic policy with empty payer approved list', () => {
    const policy = {
      version: '1.0',
      economic: {
        budgets: [
          { scope: 'session', limit: 100, currency: 'USD', window: 'session' },
        ],
        payer: {
          required: true,
          approved: [],
        },
      },
    };
    expect(() => validatePolicyIR(policy)).not.toThrow();
  });

  it('should reject budget missing required fields', () => {
    const policy = {
      version: '1.0',
      economic: {
        budgets: [
          { scope: 'session', limit: 100 },
          // Missing currency and window
        ],
      },
    };
    expect(() => validatePolicyIR(policy)).toThrow();
  });
});
