import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { collectHeuristicPacksForSingleTool } from '../../src/core/tool-pack-heuristics.js';
import { evaluateRulesLocally } from '../../src/rules/local-evaluator.js';
import { resolveBuiltInPolicyPackPath } from '../../src/rules/policy-packs.js';
import { validatePolicyIR } from '../../src/rules/schema-validator.js';
import type { Rule } from '../../src/rules/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SDK_ROOT = join(__dirname, '..', '..');

type ParsedPack = {
  rules?: Rule[];
};

function loadPack(): ParsedPack {
  return parseYaml(readFileSync(join(SDK_ROOT, 'packs', 'logistics-authority.yaml'), 'utf-8')) as ParsedPack;
}

describe('logistics authority policy pack', () => {
  it('validates the bundled yaml pack', () => {
    expect(() => validatePolicyIR(loadPack())).not.toThrow();
  });

  it('resolves the built-in pack by short and scoped name', () => {
    expect(resolveBuiltInPolicyPackPath('logistics-authority')).toContain('logistics-authority.yaml');
    expect(resolveBuiltInPolicyPackPath('@veto/logistics-authority')).toContain('logistics-authority.yaml');
  });

  it('matches logistics heuristics for TMS, customs, and carrier tools', () => {
    expect(collectHeuristicPacksForSingleTool('update_tms_eta')).toContain('@veto/logistics-authority');
    expect(collectHeuristicPacksForSingleTool('customs_duty_commit')).toContain('@veto/logistics-authority');
    expect(collectHeuristicPacksForSingleTool('get_carrier_status')).toContain('@veto/logistics-authority');
  });

  it('blocks TMS ETA updates until carrier confirmation is in the path', () => {
    const rules = loadPack().rules ?? [];

    expect(evaluateRulesLocally(rules, 'update_tms_eta', {
      arguments: { shipment_id: 'S-1', eta: '2026-05-30T14:00:00Z' },
    }, {
      now_ms: Date.parse('2026-05-30T12:00:00Z'),
      history: [],
    })).toMatchObject({
      decision: 'deny',
      ruleId: 'logistics-tms-eta-write-requires-carrier-confirmation',
    });

    expect(evaluateRulesLocally(rules, 'update_tms_eta', {
      arguments: { shipment_id: 'S-1', eta: '2026-05-30T14:00:00Z' },
    }, {
      now_ms: Date.parse('2026-05-30T12:00:00Z'),
      history: [
        {
          toolName: 'get_carrier_status',
          arguments: { shipment_id: 'S-1' },
          decision: 'allow',
          timestamp: '2026-05-30T11:50:00Z',
        },
        {
          toolName: 'carrier_confirmation',
          arguments: { shipment_id: 'S-1' },
          decision: 'allow',
          timestamp: '2026-05-30T11:55:00Z',
        },
      ],
    })).toMatchObject({ decision: null });
  });

  it('requires approval for high customs duty commitments', () => {
    const rules = loadPack().rules ?? [];

    expect(evaluateRulesLocally(rules, 'customs_duty_commit', {
      arguments: { shipment_id: 'S-1', amount_eur: 7500 },
    }, {
      history: [
        {
          toolName: 'classify_hs_code',
          arguments: { shipment_id: 'S-1' },
          decision: 'allow',
          timestamp: '2026-05-30T10:00:00Z',
        },
        {
          toolName: 'validate_customs_documents',
          arguments: { shipment_id: 'S-1' },
          decision: 'allow',
          timestamp: '2026-05-30T10:05:00Z',
        },
      ],
      now_ms: Date.parse('2026-05-30T12:00:00Z'),
    })).toMatchObject({
      decision: 'require_approval',
      ruleId: 'logistics-customs-duty-approval-threshold',
    });
  });
});
