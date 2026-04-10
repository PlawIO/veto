import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { collectHeuristicPacksForSingleTool } from '../../src/core/tool-pack-heuristics.js';
import { evaluateCondition } from '../../src/rules/condition-evaluator.js';
import { resolveBuiltInPolicyPackPath } from '../../src/rules/policy-packs.js';
import { validatePolicyIR } from '../../src/rules/schema-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SDK_ROOT = join(__dirname, '..', '..');

describe('crypto trading policy pack', () => {
  it('validates the bundled yaml pack', () => {
    const packPath = join(SDK_ROOT, 'packs', 'crypto-trading.yaml');
    const parsed = parseYaml(readFileSync(packPath, 'utf-8'));
    expect(() => validatePolicyIR(parsed)).not.toThrow();
  });

  it('resolves the built-in pack by short and scoped name', () => {
    expect(resolveBuiltInPolicyPackPath('crypto-trading')).toContain('crypto-trading.yaml');
    expect(resolveBuiltInPolicyPackPath('@veto/crypto-trading')).toContain('crypto-trading.yaml');
  });

  it('matches crypto trading heuristics before broader financial heuristics', () => {
    expect(collectHeuristicPacksForSingleTool('place_order')).toContain('@veto/crypto-trading');
    expect(collectHeuristicPacksForSingleTool('get_market_odds')).toContain('@veto/crypto-trading');
  });

  it('supports new comparison operators needed by the pack', () => {
    expect(evaluateCondition({
      field: 'arguments.amount',
      operator: 'greater_than_or_equal',
      value: 200,
    }, { arguments: { amount: 200 } })).toBe(true);

    expect(evaluateCondition({
      field: 'arguments.amount',
      operator: 'less_than_or_equal',
      value: 50,
    }, { arguments: { amount: 50 } })).toBe(true);

    expect(evaluateCondition({
      field: 'arguments.stop_loss',
      operator: 'not_exists',
    }, { arguments: {} })).toBe(true);
  });

  it('supports simple string time windows for UTC timestamps', () => {
    expect(evaluateCondition({
      field: 'timestamp',
      operator: 'outside_hours',
      value: '06:00-23:59',
    }, {
      timestamp: '2026-04-10T02:00:00Z',
    })).toBe(true);

    expect(evaluateCondition({
      field: 'timestamp',
      operator: 'outside_hours',
      value: '06:00-23:59',
    }, {
      timestamp: '2026-04-10T12:00:00Z',
    })).toBe(false);
  });
});
