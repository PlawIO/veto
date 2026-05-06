import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runCloudOrgUseCommand, runGuardCheckCommand, runPolicyGenerateCommand } from '../../src/cli/headless.js';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = '/tmp/veto-policy-cli-test-' + Date.now();

function writeFixture(relativePath: string, content: string): void {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

describe('policy generate', () => {
  const originalEnv = {
    VETO_API_KEY: process.env.VETO_API_KEY,
    VETO_API_URL: process.env.VETO_API_URL,
    HOME: process.env.HOME,
  };

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    delete process.env.VETO_API_KEY;
    delete process.env.VETO_API_URL;

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

    if (originalEnv.VETO_API_KEY) {
      process.env.VETO_API_KEY = originalEnv.VETO_API_KEY;
    } else {
      delete process.env.VETO_API_KEY;
    }

    if (originalEnv.VETO_API_URL) {
      process.env.VETO_API_URL = originalEnv.VETO_API_URL;
    } else {
      delete process.env.VETO_API_URL;
    }

    if (originalEnv.HOME) {
      process.env.HOME = originalEnv.HOME;
    } else {
      delete process.env.HOME;
    }
  });

  it('uses local deterministic fallback by default for keyless local generation', async () => {
    const result = await runPolicyGenerateCommand({
      projectDir: TEST_DIR,
      tool: 'bash',
      prompt: 'block rm -rf',
      modeHint: 'deterministic',
      target: 'local',
    });

    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe('template');
    expect(result.data?.warnings.some((warning) => warning.includes('local deterministic template fallback'))).toBe(true);
    expect(result.data?.warnings.some((warning) => warning.includes('No prompt or policy data leaves this machine'))).toBe(true);

    const parsed = parseYaml(result.data!.yaml) as {
      rules: Array<{ action: string; tools: string[] }>;
    };
    expect(parsed.rules[0]?.action).toBe('block');
    expect(parsed.rules[0]?.tools).toEqual(['bash']);
  });

  it('fails keyless local generation when template fallback is disabled', async () => {
    const result = await runPolicyGenerateCommand({
      projectDir: TEST_DIR,
      tool: 'bash',
      prompt: 'block rm -rf',
      target: 'local',
      allowTemplateFallback: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_generate_failed');
    expect(result.error?.message).toContain('No generation endpoint configured');
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

  it('fails local guard checks when configured rules cannot be loaded', async () => {
    const guardCheck = await runGuardCheckCommand({
      projectDir: TEST_DIR,
      tool: 'transfer_funds',
      argsJson: JSON.stringify({ amount: 600 }),
      mode: 'local',
    });

    expect(guardCheck.ok).toBe(false);
    expect(guardCheck.error?.code).toBe('guard_local_failed');
    expect(guardCheck.error?.message).toContain('Rules directory does not exist');
  });

  it('fails local guard checks when configured rules are empty', async () => {
    mkdirSync(join(TEST_DIR, 'veto', 'rules'), { recursive: true });

    const guardCheck = await runGuardCheckCommand({
      projectDir: TEST_DIR,
      tool: 'transfer_funds',
      argsJson: JSON.stringify({ amount: 600 }),
      mode: 'local',
    });

    expect(guardCheck.ok).toBe(false);
    expect(guardCheck.error?.code).toBe('guard_local_failed');
    expect(guardCheck.error?.message).toContain('does not contain policy YAML files');
  });

  it('writes cloud session updates with restrictive permissions', () => {
    const homeDir = join(TEST_DIR, 'home');
    const sessionDir = join(homeDir, '.veto');
    const sessionPath = join(sessionDir, 'cloud-session.json');
    process.env.HOME = homeDir;

    mkdirSync(sessionDir, { recursive: true, mode: 0o755 });
    writeFileSync(sessionPath, JSON.stringify({ baseUrl: 'https://api.veto.so', accessToken: 'token' }), {
      encoding: 'utf-8',
      mode: 0o644,
    });

    const result = runCloudOrgUseCommand('org_123');

    expect(result.ok).toBe(true);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(sessionPath, 'utf-8')).toContain('org_123');
  });
});
