import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from '../../src/cli/init.js';
import {
  getBuiltInPolicyPackNames,
  resolveBuiltInPolicyPackPath,
} from '../../src/rules/policy-packs.js';
import { validatePolicyIR } from '../../src/rules/schema-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SDK_ROOT = join(__dirname, '..', '..');
const COMPLIANCE_PACKS = [
  { shortName: 'soc2-lite', scopedName: '@veto/soc2-lite', fileName: 'soc2-lite.yaml' },
  { shortName: 'hipaa-lite', scopedName: '@veto/hipaa-lite', fileName: 'hipaa-lite.yaml' },
  { shortName: 'eu-ai-act-starter', scopedName: '@veto/eu-ai-act-starter', fileName: 'eu-ai-act-starter.yaml' },
] as const;

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
