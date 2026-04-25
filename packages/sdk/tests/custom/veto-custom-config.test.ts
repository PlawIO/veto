import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = `/tmp/veto-custom-config-test-${Date.now()}`;
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

function writeConfig(customYaml: string): void {
  writeFileSync(
    join(VETO_DIR, 'veto.config.yaml'),
    `
version: "1.0"
mode: "strict"
validation:
  mode: "custom"
logging:
  level: "silent"
rules:
  directory: "./rules"
custom:
${customYaml}
`,
    'utf-8'
  );
}

function writeRule(): void {
  writeFileSync(
    join(RULES_DIR, 'rules.yaml'),
    `
version: "1.0"
rules:
  - id: custom-check
    name: Custom check
    action: block
    tools: [danger_tool]
`,
    'utf-8'
  );
}

describe('Veto custom validation configuration errors', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(RULES_DIR, { recursive: true });
    writeRule();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns a strict-mode denial reason for missing custom.provider', async () => {
    writeConfig('  model: "gpt-test"');

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('danger_tool', {});

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('custom.provider');
  });

  it('returns a strict-mode denial reason for missing custom.model', async () => {
    writeConfig('  provider: "openai"');

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('danger_tool', {});

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('custom.model');
  });
});
