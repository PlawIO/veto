import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGuardCheckCommand, runPolicyGenerateCommand } from '../../src/cli/headless.js';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = '/tmp/veto-policy-cli-test-' + Date.now();

function writeFixture(relativePath: string, content: string): void {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

describe('policy generate', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    writeFixture(
      'src/agent.ts',
      `const tools = {
  send_email: tool({ execute: async () => null }),
  transfer_funds: tool({ execute: async () => null }),
};
`
    );

    writeFixture(
      'veto/veto.config.yaml',
      `version: "1.0"
mode: "strict"
validation:
  mode: "local"
approval:
  callbackUrl: "http://localhost:9999/approvals"
logging:
  level: "silent"
rules:
  directory: "./rules"
`
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('honors the requested tool in local generation and produces an enforceable rule', async () => {
    const result = await runPolicyGenerateCommand({
      projectDir: TEST_DIR,
      tool: 'transfer_funds',
      prompt: 'require approval above $500',
      target: 'local',
      savePath: 'veto/rules/generated.yaml',
      demoTemplate: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe('template');
    expect(result.data?.savedTo).toBe(join(TEST_DIR, 'veto', 'rules', 'generated.yaml'));

    const parsed = parseYaml(readFileSync(result.data!.savedTo!, 'utf-8')) as {
      rules: Array<{ id: string; action: string; tools: string[] }>;
    };
    expect(parsed.rules[0]?.action).toBe('require_approval');
    expect(parsed.rules[0]?.tools).toEqual(['transfer_funds']);

    const veto = await Veto.init({ configDir: join(TEST_DIR, 'veto') });

    const highValueTransfer = await veto.guard('transfer_funds', { amount: 600 });
    const lowValueTransfer = await veto.guard('transfer_funds', { amount: 100 });
    const unrelatedTool = await veto.guard('send_email', { amount: 600 });

    expect(highValueTransfer.decision).toBe('require_approval');
    expect(lowValueTransfer.decision).toBe('allow');
    expect(unrelatedTool.decision).toBe('allow');

    const guardCheck = await runGuardCheckCommand({
      projectDir: TEST_DIR,
      tool: 'transfer_funds',
      argsJson: JSON.stringify({ amount: 600 }),
      mode: 'local',
    });

    expect(guardCheck.ok).toBe(true);
    expect(guardCheck.data?.decision).toBe('require_approval');
    expect(guardCheck.data?.ruleId).toBe(parsed.rules[0]?.id);
  });

  it('uses the explicit tool name even when the workspace scan does not discover it', async () => {
    const result = await runPolicyGenerateCommand({
      projectDir: TEST_DIR,
      tool: 'approve_invoice',
      prompt: 'block anything above $1000',
      target: 'local',
      demoTemplate: true,
    });

    expect(result.ok).toBe(true);
    expect(result.data?.warnings).toContain(
      "Tool 'approve_invoice' is not currently discovered in workspace scan. Using the explicit tool name with empty parameter context."
    );

    const parsed = parseYaml(result.data!.yaml) as {
      rules: Array<{ tools: string[] }>;
    };
    expect(parsed.rules[0]?.tools).toEqual(['approve_invoice']);
  });
});
