import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from '../../src/cli/init.js';
import { evaluateRulesLocally } from '../../src/rules/local-evaluator.js';
import {
  getBuiltInPolicyPackNames,
  resolveBuiltInPolicyPackPath,
} from '../../src/rules/policy-packs.js';
import { validatePolicyIR } from '../../src/rules/schema-validator.js';
import type { Rule } from '../../src/rules/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SDK_ROOT = join(__dirname, '..', '..');
const COMPLIANCE_PACKS = [
  { shortName: 'soc2-lite', scopedName: '@veto/soc2-lite', fileName: 'soc2-lite.yaml' },
  { shortName: 'hipaa-lite', scopedName: '@veto/hipaa-lite', fileName: 'hipaa-lite.yaml' },
  { shortName: 'eu-ai-act-starter', scopedName: '@veto/eu-ai-act-starter', fileName: 'eu-ai-act-starter.yaml' },
] as const;

type ParsedPack = {
  rules?: Rule[];
};

let tempDirs: string[] = [];

describe('compliance policy packs', () => {
  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it.each(COMPLIANCE_PACKS)('validates $scopedName YAML', ({ fileName }) => {
    const packPath = join(SDK_ROOT, 'packs', fileName);
    const parsed = parseYaml(readFileSync(packPath, 'utf-8'));

    expect(() => validatePolicyIR(parsed)).not.toThrow();
  });

  it.each(COMPLIANCE_PACKS)('does not mix conditions and condition_groups in $scopedName rules', ({ fileName }) => {
    const packPath = join(SDK_ROOT, 'packs', fileName);
    const parsed = parseYaml(readFileSync(packPath, 'utf-8')) as ParsedPack;
    const unsafeRuleIds = (parsed.rules ?? [])
      .filter((rule) => (rule.conditions?.length ?? 0) > 0 && (rule.condition_groups?.length ?? 0) > 0)
      .map((rule) => rule.id ?? '<unknown>');

    expect(unsafeRuleIds).toEqual([]);
  });

  it('preserves HIPAA shared constraints inside condition_groups', () => {
    const packPath = join(SDK_ROOT, 'packs', 'hipaa-lite.yaml');
    const parsed = parseYaml(readFileSync(packPath, 'utf-8')) as ParsedPack;
    const rules = parsed.rules ?? [];

    expect(evaluateRulesLocally(rules, 'http_request', {
      custom: { phi_transfer_approved: false },
      arguments: { contains_phi: true },
    })).toMatchObject({ decision: 'deny', ruleId: 'hipaa-block-unapproved-phi-network-send' });
    expect(evaluateRulesLocally(rules, 'http_request', {
      custom: { phi_transfer_approved: true },
      arguments: { contains_phi: true },
    })).toMatchObject({ decision: null });
    expect(evaluateRulesLocally(rules, 'read_record', {
      custom: { phi_access_approved: false },
      arguments: { record_type: 'patient chart' },
    })).toMatchObject({ decision: 'require_approval', ruleId: 'hipaa-require-context-for-medical-record-access' });
    expect(evaluateRulesLocally(rules, 'read_record', {
      custom: { phi_access_approved: true },
      arguments: { record_type: 'patient chart' },
    })).toMatchObject({ decision: null });
    expect(evaluateRulesLocally(rules, 'query_database', {
      arguments: { limit: 250, dataset: 'clinical phi export' },
    })).toMatchObject({ decision: 'require_approval', ruleId: 'hipaa-require-approval-bulk-record-export' });
    expect(evaluateRulesLocally(rules, 'query_database', {
      arguments: { limit: 25, dataset: 'clinical phi export' },
    })).toMatchObject({ decision: null });
  });

  it.each(COMPLIANCE_PACKS)('resolves $scopedName by short and scoped name', ({ shortName, scopedName, fileName }) => {
    expect(resolveBuiltInPolicyPackPath(shortName)).toContain(fileName);
    expect(resolveBuiltInPolicyPackPath(scopedName)).toContain(fileName);
  });

  it('includes all compliance packs in the built-in registry', () => {
    expect(getBuiltInPolicyPackNames()).toEqual(
      expect.arrayContaining(COMPLIANCE_PACKS.map((pack) => pack.scopedName))
    );
  });

  it.each(COMPLIANCE_PACKS)('init scaffolds extends for $shortName', async ({ shortName, scopedName }) => {
    const tempDir = mkdtempSync(join(tmpdir(), `veto-${shortName}-`));
    tempDirs.push(tempDir);

    const result = await init({ directory: tempDir, pack: shortName, quiet: true });
    const defaultsYaml = readFileSync(join(tempDir, 'veto', 'rules', 'defaults.yaml'), 'utf-8');

    expect(result.success).toBe(true);
    expect(defaultsYaml).toContain(`extends: "${scopedName}"`);
  });
});
