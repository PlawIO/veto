import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { diff } from '../../src/cli/diff.js';

let TEST_DIR = '';

function writeFixture(relativePath: string, content: string): string {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
  return absolutePath;
}

function initGitRepo(directory: string): void {
  execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: directory });
}

function commitAll(directory: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-m', message], { cwd: directory, stdio: 'ignore' });
}

describe('veto diff', () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'veto-diff-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (TEST_DIR) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('compares working policy file against HEAD with implicit git mode', async () => {
    writeFixture(
      'veto/rules/financial.yaml',
      `version: "1.0"
name: financial
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: block
    tools:
      - transfer_funds
`
    );

    initGitRepo(TEST_DIR);
    commitAll(TEST_DIR, 'baseline');

    writeFixture(
      'veto/rules/financial.yaml',
      `version: "1.0"
name: financial
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: require_approval
    tools:
      - transfer_funds
`
    );

    const result = await diff({
      directory: TEST_DIR,
      policyPath: 'financial.yaml',
      quiet: true,
    });

    expect(result.success).toBe(true);
    expect(result.report?.sources.mode).toBe('implicit-git-file');
    expect(result.report?.structural.modifiedRuleIds).toEqual(['transfer-limit']);

    const change = result.report?.structural.ruleChanges.find((entry) => entry.ruleId === 'transfer-limit');
    expect(change?.summary).toContain('Action changed: block -> require_approval');
  });

  it('computes added, removed, and modified rules in explicit file mode', async () => {
    writeFixture(
      'old.yaml',
      `version: "1.0"
name: old
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: less_than
        value: 10000
  - id: email-log
    name: Email log
    enabled: true
    severity: low
    action: log
    tools: [send_email]
`
    );

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: less_than
        value: 5000
  - id: kyc-approval
    name: KYC approval
    enabled: true
    severity: medium
    action: require_approval
    tools: [transfer_funds]
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      quiet: true,
    });

    expect(result.success).toBe(true);
    expect(result.report?.sources.mode).toBe('explicit-file');
    expect(result.report?.structural.addedRuleIds).toEqual(['kyc-approval']);
    expect(result.report?.structural.removedRuleIds).toEqual(['email-log']);
    expect(result.report?.structural.modifiedRuleIds).toEqual(['transfer-limit']);

    const modified = result.report?.structural.ruleChanges.find((entry) => entry.ruleId === 'transfer-limit');
    expect(modified?.summary).toContain('arguments.amount less_than changed 10000 -> 5000');
  });

  it('loads recursive directories in explicit directory mode', async () => {
    writeFixture(
      'old-rules/global.yaml',
      `version: "1.0"
name: old-global
rules:
  - id: baseline
    name: Baseline
    enabled: true
    severity: medium
    action: log
`
    );

    writeFixture(
      'old-rules/nested/tools.yaml',
      `version: "1.0"
name: old-tools
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
`
    );

    writeFixture(
      'new-rules/global.yaml',
      `version: "1.0"
name: new-global
rules:
  - id: baseline
    name: Baseline
    enabled: true
    severity: medium
    action: require_approval
`
    );

    writeFixture(
      'new-rules/nested/tools.yaml',
      `version: "1.0"
name: new-tools
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
  - id: send-email-guard
    name: Send email guard
    enabled: true
    severity: high
    action: block
    tools: [send_email]
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old-rules',
      new: 'new-rules',
      quiet: true,
    });

    expect(result.success).toBe(true);
    expect(result.report?.sources.mode).toBe('explicit-directory');
    expect(result.report?.structural.addedRuleIds).toEqual(['send-email-guard']);
    expect(result.report?.structural.modifiedRuleIds).toEqual(['baseline']);
  });

  it('fails validation when --old and --new types are mixed', async () => {
    writeFixture(
      'old.yaml',
      `version: "1.0"
name: old
rules:
  - id: only-old
    name: Only old
    enabled: true
    severity: medium
    action: block
`
    );

    writeFixture(
      'new-rules/main.yaml',
      `version: "1.0"
name: new
rules:
  - id: only-new
    name: Only new
    enabled: true
    severity: medium
    action: block
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new-rules',
      quiet: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('both paths to be files or both directories');
  });

  it('groups structural changes by global and tool scopes', async () => {
    writeFixture(
      'old.yaml',
      `version: "1.0"
name: old
rules:
  - id: alpha
    name: Alpha
    enabled: true
    severity: medium
    action: block
    tools: [alpha_tool]
`
    );

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: alpha
    name: Alpha
    enabled: true
    severity: medium
    action: block
    tools: [alpha_tool]
  - id: global-review
    name: Global review
    enabled: true
    severity: high
    action: require_approval
  - id: beta
    name: Beta
    enabled: true
    severity: high
    action: block
    tools: [beta_tool]
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      quiet: true,
    });

    expect(result.success).toBe(true);

    const scopes = result.report?.structural.changesByScope.map((entry) => entry.scope) ?? [];
    expect(scopes).toEqual(['GLOBAL', 'beta_tool']);
    expect(result.report?.structural.unchangedTools).toEqual(['alpha_tool']);
  });

  it('emits action change summaries for modified rules', async () => {
    writeFixture(
      'old.yaml',
      `version: "1.0"
name: old
rules:
  - id: wire-transfer
    name: Wire transfer
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
`
    );

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: wire-transfer
    name: Wire transfer
    enabled: true
    severity: high
    action: require_approval
    tools: [transfer_funds]
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      quiet: true,
    });

    const change = result.report?.structural.ruleChanges.find((entry) => entry.ruleId === 'wire-transfer');
    expect(change?.summary).toBe('Action changed: block -> require_approval');
  });

  it('prints parseable JSON with stable top-level fields', async () => {
    writeFixture(
      'old.yaml',
      `version: "1.0"
name: old
rules:
  - id: baseline
    name: Baseline
    enabled: true
    severity: medium
    action: log
`
    );

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: baseline
    name: Baseline
    enabled: true
    severity: medium
    action: require_approval
`
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      format: 'json',
      quiet: false,
    });

    expect(result.success).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const payload = logSpy.mock.calls[0][0];
    expect(typeof payload).toBe('string');

    const parsed = JSON.parse(payload as string) as {
      timestamp: string;
      sources: { mode: string };
      structural: { modifiedRuleIds: string[] };
      summary: { modified: number };
    };

    expect(parsed.timestamp).toBeTruthy();
    expect(parsed.sources.mode).toBe('explicit-file');
    expect(parsed.structural.modifiedRuleIds).toEqual(['baseline']);
    expect(parsed.summary.modified).toBe(1);
  });

  it('replays logs deterministically and reports transition counts', async () => {
    writeFixture('old.yaml', 'version: "1.0"\nname: old\nrules: []\n');

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: transfer-block
    name: Transfer block
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
`
    );

    writeFixture(
      'calls.jsonl',
      `{"tool":"transfer_funds","arguments":{"amount":2000}}
{"tool":"transfer_funds","arguments":{"amount":100}}
{"tool":"send_email","arguments":{"to":"a@company.com"}}
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      log: 'calls.jsonl',
      quiet: true,
    });

    expect(result.success).toBe(true);
    expect(result.report?.impact?.validCalls).toBe(3);
    expect(result.report?.impact?.additionalDenied).toBe(1);
    expect(result.report?.impact?.transitions['allow->deny']).toBe(1);
  });

  it('honors sequence constraints with within windows during replay', async () => {
    writeFixture('old.yaml', 'version: "1.0"\nname: old\nrules: []\n');

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: transfer-requires-approval
    name: Require recent approval
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    requires:
      - tool: approve_transfer
        within: 60
`
    );

    writeFixture(
      'calls.jsonl',
      `{"tool":"transfer_funds","arguments":{"amount":100},"timestamp":"2026-01-01T00:00:00.000Z"}
{"tool":"approve_transfer","arguments":{"amount":100},"timestamp":"2026-01-01T00:00:10.000Z"}
{"tool":"transfer_funds","arguments":{"amount":100},"timestamp":"2026-01-01T00:00:20.000Z"}
{"tool":"transfer_funds","arguments":{"amount":100},"timestamp":"2026-01-01T00:03:30.000Z"}
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      log: 'calls.jsonl',
      quiet: true,
    });

    expect(result.success).toBe(true);
    expect(result.report?.impact?.additionalDenied).toBe(2);
    expect(result.report?.impact?.transitions['allow->deny']).toBe(2);
  });

  it('honors agent include scopes in replay decisions', async () => {
    writeFixture('old.yaml', 'version: "1.0"\nname: old\nrules: []\n');

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: scoped-email-block
    name: Scoped email block
    enabled: true
    severity: high
    action: block
    tools: [send_email]
    agents:
      - agent-a
`
    );

    writeFixture(
      'calls.jsonl',
      `{"tool_name":"send_email","args":{"to":"a@company.com"},"agent_id":"agent-a"}
{"tool_name":"send_email","args":{"to":"b@company.com"},"agent_id":"agent-b"}
not-json
{"tool_name":"send_email","args":"bad"}
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      log: 'calls.jsonl',
      quiet: true,
    });

    expect(result.success).toBe(true);
    expect(result.report?.impact?.validCalls).toBe(2);
    expect(result.report?.impact?.invalidLines).toBe(2);
    expect(result.report?.impact?.additionalDenied).toBe(1);
  });

  it('fails when replay log has no valid calls', async () => {
    writeFixture('old.yaml', 'version: "1.0"\nname: old\nrules: []\n');
    writeFixture('new.yaml', 'version: "1.0"\nname: new\nrules: []\n');

    writeFixture('calls.jsonl', 'not-json\n{"tool":"send_email"}\n');

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      log: 'calls.jsonl',
      quiet: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('No valid replay calls');
  });

  it('fails when snapshots contain duplicate rule IDs', async () => {
    writeFixture(
      'old.yaml',
      `version: "1.0"
name: old
rules:
  - id: duplicate
    name: First
    enabled: true
    severity: high
    action: block
  - id: duplicate
    name: Second
    enabled: true
    severity: high
    action: block
`
    );

    writeFixture('new.yaml', 'version: "1.0"\nname: new\nrules: []\n');

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      quiet: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('duplicate rule IDs');
  });

  it('keeps scope ordering deterministic (GLOBAL first, then alphabetical)', async () => {
    writeFixture('old.yaml', 'version: "1.0"\nname: old\nrules: []\n');

    writeFixture(
      'new.yaml',
      `version: "1.0"
name: new
rules:
  - id: tool-b
    name: Tool B
    enabled: true
    severity: medium
    action: block
    tools: [tool_b]
  - id: global
    name: Global
    enabled: true
    severity: medium
    action: log
  - id: tool-a
    name: Tool A
    enabled: true
    severity: medium
    action: block
    tools: [tool_a]
`
    );

    const result = await diff({
      directory: TEST_DIR,
      old: 'old.yaml',
      new: 'new.yaml',
      quiet: true,
    });

    const scopes = result.report?.structural.changesByScope.map((entry) => entry.scope);
    expect(scopes).toEqual(['GLOBAL', 'tool_a', 'tool_b']);
  });
});
