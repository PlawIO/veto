import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createReplSessionContext,
  executeReplInput,
  generatePolicyFromPrompt,
  generateTemplatePolicy,
  loadHistoryFile,
  persistHistoryFile,
  validateGeneratedYaml,
} from '../../src/cli/index.js';

const TEST_DIR = `/tmp/veto-repl-test-${Date.now()}`;

function writeFixture(relativePath: string, content: string): void {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

describe('veto repl', () => {
  const originalEnv = {
    VETO_API_KEY: process.env.VETO_API_KEY,
    VETO_API_URL: process.env.VETO_API_URL,
  };

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });

    delete process.env.VETO_API_KEY;
    delete process.env.VETO_API_URL;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
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
  });

  it('/test reports deny and allow outcomes', async () => {
    writeFixture(
      'veto/rules/financial.yaml',
      `version: "1.0"
name: financial
rules:
  - id: fin-block-high-transfers
    name: Block high transfers
    enabled: true
    severity: high
    action: block
    tools:
      - transfer_funds
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 10000
`
    );

    const context = await createReplSessionContext(TEST_DIR);

    const denied = await executeReplInput('/test transfer_funds({"amount":50000})', context);
    expect(denied.ok).toBe(false);
    expect(denied.lines[0]).toContain('DENIED');
    expect(denied.lines[0]).toContain('fin-block-high-transfers');

    const allowed = await executeReplInput('/test transfer_funds({"amount":500})', context);
    expect(allowed.ok).toBe(true);
    expect(allowed.lines[0]).toContain('ALLOWED');
  });

  it('/explain uses template explanation without API key', async () => {
    writeFixture(
      'veto/rules/rules.yaml',
      `version: "1.0"
name: base
rules:
  - id: block-external-email
    name: Block external email
    enabled: true
    severity: high
    action: block
    tools: [send_email]
    conditions:
      - field: arguments.to
        operator: not_contains
        value: "@company.com"
`
    );

    const context = await createReplSessionContext(TEST_DIR);
    const result = await executeReplInput('/explain block-external-email', context);

    expect(result.ok).toBe(true);
    expect(result.lines[0]).toContain('block calls to send_email');
  });

  it('supports /list, /load, /export, and /clear', async () => {
    writeFixture(
      'veto/rules/base.yaml',
      `version: "1.0"
name: base
rules:
  - id: base-rule
    name: Base rule
    enabled: true
    severity: medium
    action: block
    tools: [read_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc
`
    );

    writeFixture(
      'extra.yaml',
      `version: "1.0"
name: extra
rules:
  - id: extra-rule
    name: Extra rule
    enabled: true
    severity: low
    action: warn
    tools: [send_email]
`
    );

    const context = await createReplSessionContext(TEST_DIR);

    const initialList = await executeReplInput('/list', context);
    expect(initialList.lines.join('\n')).toContain('base-rule');

    const loaded = await executeReplInput('/load extra.yaml', context);
    expect(loaded.ok).toBe(true);
    expect(loaded.lines[0]).toContain('Loaded 1 rule(s)');

    const afterLoadList = await executeReplInput('/list', context);
    expect(afterLoadList.lines.join('\n')).toContain('extra-rule');

    const exported = await executeReplInput('/export ./exports/repl.generated.yaml', context, {
      ask: async () => 'y',
    });
    expect(exported.ok).toBe(true);
    expect(existsSync(join(TEST_DIR, 'exports/repl.generated.yaml'))).toBe(true);

    const cleared = await executeReplInput('/clear', context);
    expect(cleared.ok).toBe(true);

    const afterClearList = await executeReplInput('/list', context);
    expect(afterClearList.lines.join('\n')).not.toContain('extra-rule');
  });

  it('uses template generation without LLM configuration', async () => {
    const result = await generatePolicyFromPrompt({
      prompt: 'block transfer_funds over $25000',
      projectDir: TEST_DIR,
      rulesDirectory: join(TEST_DIR, 'veto/rules'),
      tools: [
        {
          name: 'transfer_funds',
          parameters: ['amount'],
          locations: ['src/agent.ts'],
          sources: ['source-ts'],
          covered: false,
          coverageReason: 'none',
          matchedRuleIds: [],
        },
      ],
      existingRules: [],
    });

    expect(result.mode).toBe('template');
    expect(result.yaml).toContain('transfer_funds');
    expect(result.warnings.some((warning) => warning.includes('No API key or kernel config configured'))).toBe(true);
  });

  it('rejects invalid YAML documents via schema validation', () => {
    expect(() =>
      validateGeneratedYaml(
        `version: "1.0"\nrules:\n  - id: incomplete\n`
      )
    ).toThrow();
  });

  it('generates multiple rules from a single prompt in template mode', () => {
    const generated = generateTemplatePolicy(
      'block transfer_funds and wire_transfer over $5000',
      [
        {
          name: 'transfer_funds',
          parameters: ['amount'],
          locations: ['src/a.ts'],
          sources: ['source-ts'],
          covered: false,
          coverageReason: 'none',
          matchedRuleIds: [],
        },
        {
          name: 'wire_transfer',
          parameters: ['amount'],
          locations: ['src/b.ts'],
          sources: ['source-ts'],
          covered: false,
          coverageReason: 'none',
          matchedRuleIds: [],
        },
      ],
      []
    );

    const parsed = validateGeneratedYaml(generated.yaml);
    const rules = parsed.rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(2);
  });

  it('maps negated approval prompts to block action in template mode', () => {
    const generated = generateTemplatePolicy(
      'do not approve invoices above 50 dollars',
      [
        {
          name: 'approve_invoice',
          parameters: ['amount'],
          locations: ['src/invoice.ts'],
          sources: ['source-ts'],
          covered: false,
          coverageReason: 'none',
          matchedRuleIds: [],
        },
      ],
      []
    );

    const parsed = validateGeneratedYaml(generated.yaml);
    const rules = parsed.rules as Array<{ action?: string }>;
    expect(rules[0]?.action).toBe('block');
  });

  it('blocks generation when no endpoint is configured and template fallback is disabled', async () => {
    await expect(() =>
      generatePolicyFromPrompt({
        prompt: 'block transfer_funds above 1000',
        projectDir: TEST_DIR,
        rulesDirectory: join(TEST_DIR, 'veto/rules'),
        tools: [
          {
            name: 'transfer_funds',
            parameters: ['amount'],
            locations: ['src/agent.ts'],
            sources: ['source-ts'],
            covered: false,
            coverageReason: 'none',
            matchedRuleIds: [],
          },
        ],
        existingRules: [],
        allowTemplateFallback: false,
      })
    ).rejects.toThrow('No generation endpoint configured');
  });

  it('persists bounded deduplicated command history', () => {
    const historyPath = join(TEST_DIR, '.veto_history');
    writeFileSync(historyPath, 'one\ntwo\none\n', 'utf-8');

    const loaded = loadHistoryFile(historyPath, 5);
    expect(loaded).toEqual(['two', 'one']);

    persistHistoryFile(historyPath, loaded, ['three', 'two', 'four'], 3);
    const content = readFileSync(historyPath, 'utf-8').trim().split(/\r?\n/);

    expect(content).toEqual(['three', 'two', 'four']);
  });

  it('/scan can apply suggested packs with confirmation', async () => {
    writeFixture(
      'src/agent.ts',
      `const transfer = tool({
  name: 'transfer_funds',
  execute: async ({ amount }) => amount,
});
`
    );

    const context = await createReplSessionContext(TEST_DIR);
    const result = await executeReplInput('/scan', context, {
      ask: async () => 'y',
    });

    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => line.includes('Applied @veto/financial'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'veto/rules/financial.yaml'))).toBe(true);
  });

  it('supports generation save flow with edit and validation', async () => {
    writeFixture(
      'src/agent.ts',
      `const transfer = tool({
  name: 'transfer_funds',
  execute: async ({ amount }) => amount,
});
`
    );

    const context = await createReplSessionContext(TEST_DIR);

    const answers = ['edit', 'y'];
    const result = await executeReplInput('block transfer_funds over $25000', context, {
      ask: async () => answers.shift() ?? 'y',
      openEditor: async () => `version: "1.0"\nname: edited\nrules:\n  - id: edited-rule\n    name: Edited rule\n    enabled: true\n    severity: high\n    action: block\n    tools: [transfer_funds]\n    conditions:\n      - field: arguments.amount\n        operator: greater_than\n        value: 25000\n`,
    });

    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => line.includes('Edited YAML validated successfully.'))).toBe(true);
    const saveLine = result.lines.find((line) => line.startsWith('Saved generated rules to '));
    expect(saveLine).toBeTruthy();
    const savedPath = saveLine?.replace('Saved generated rules to ', '').trim();
    expect(savedPath ? existsSync(savedPath) : false).toBe(true);
  });

  it('routes natural language what-if prompts to simulation', async () => {
    writeFixture(
      'veto/rules/financial.yaml',
      `version: "1.0"
name: financial
rules:
  - id: fin-block-high-transfers
    name: Block high transfers
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 10000
`
    );

    const context = await createReplSessionContext(TEST_DIR);
    const result = await executeReplInput(
      'what would happen if my agent tried to transfer $50,000?',
      context
    );

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain('Simulated transfer_funds');
    expect(result.lines.join('\n')).toContain('DENIED');
  });

  it('routes natural language suite-test prompts', async () => {
    writeFixture(
      'veto/rules/financial.yaml',
      `version: "1.0"
name: financial
rules:
  - id: fin-block-high-transfers
    name: Block high transfers
    enabled: true
    severity: high
    action: block
    tools: [transfer_funds]
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 10000
`
    );

    const context = await createReplSessionContext(TEST_DIR);
    const result = await executeReplInput('test my agent against current rules', context);

    expect(result.lines[0]).toContain('Scenario suite complete');
    expect(result.lines.some((line) => line.includes('transfer_funds'))).toBe(true);
  });
});
