import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = `/tmp/veto-output-validation-test-${Date.now()}`;
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

function writeConfig(): void {
  writeFileSync(
    join(VETO_DIR, 'veto.config.yaml'),
    `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
    'utf-8'
  );
}

function writePolicy(content: string): void {
  writeFileSync(join(RULES_DIR, 'policy.yaml'), content, 'utf-8');
}

describe('Veto output validation', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });
    writeConfig();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('redacts nested fields via standalone validateOutput API', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: redact-email
    name: Redact email
    enabled: true
    action: redact
    tools: [profile_tool]
    output_conditions:
      - field: output.user.contact.email
        operator: matches
        value: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}"
    redact_with: "[EMAIL]"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const output = {
      user: {
        contact: {
          email: 'alice@example.com',
        },
      },
    };

    const result = veto.validateOutput('profile_tool', output);

    expect(result.decision).toBe('allow');
    expect((result.output as any).user.contact.email).toBe('[EMAIL]');
    expect(result.redactions).toBe(1);
    expect(result.trace).toEqual([
      {
        ruleId: 'redact-email',
        ruleName: 'Redact email',
        field: 'output.user.contact.email',
        pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
        redactedCount: 1,
        replacement: '[EMAIL]',
      },
    ]);
  });

  it('redacts matching strings anywhere in structured output when field is output', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: redact-acme
    name: Redact Acme everywhere
    enabled: true
    action: redact
    tools: [google_sheets_read]
    output_conditions:
      - field: output
        operator: matches
        value: "(?i)\\\\bacme\\\\b(?:\\\\s+(?:inc|corp|llc))?\\\\.?"
    redact_with: "[REDACTED]"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = veto.validateOutput('google_sheets_read', {
      sheet: 'Q1 Pipeline',
      rows: [
        { company: 'Acme Inc.', owner: 'alice@example.com' },
        { company: 'Globex', notes: 'Met with ACME corp yesterday' },
      ],
      summary: 'Top customer is acme llc',
    });

    expect(result.decision).toBe('allow');
    expect((result.output as any).rows[0].company).toBe('[REDACTED]');
    expect((result.output as any).rows[1].notes).toBe('Met with [REDACTED] yesterday');
    expect((result.output as any).summary).toBe('Top customer is [REDACTED]');
    expect(result.redactions).toBe(3);
    expect(result.trace).toEqual([
      {
        ruleId: 'redact-acme',
        ruleName: 'Redact Acme everywhere',
        field: 'output',
        pattern: '(?i)\\bacme\\b(?:\\s+(?:inc|corp|llc))?\\.?',
        redactedCount: 3,
        replacement: '[REDACTED]',
      },
    ]);
  });

  it('blocks output when a block output rule matches', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: block-secret
    name: Block sensitive content
    enabled: true
    action: block
    tools: [report_tool]
    description: Secret detected
    output_conditions:
      - field: output.message
        operator: contains
        value: SECRET
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = veto.validateOutput('report_tool', {
      message: 'contains SECRET value',
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toBe('Secret detected');
  });

  it('prioritizes block over redact when both rules match', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: redact-card
    name: Redact card
    enabled: true
    action: redact
    tools: [billing_tool]
    output_conditions:
      - field: output.card
        operator: matches
        value: "\\\\d{16}"
    redact_with: "[CARD]"
  - id: block-card
    name: Block card output
    enabled: true
    action: block
    tools: [billing_tool]
    output_conditions:
      - field: output.card
        operator: matches
        value: "\\\\d{16}"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = veto.validateOutput('billing_tool', { card: '4242424242424242' });

    expect(result.decision).toBe('block');
    expect(result.redactions).toBe(0);
  });

  it('rejects unsafe regex conditions', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: unsafe-block
    name: Unsafe block
    enabled: true
    action: block
    tools: [unsafe_tool]
    output_conditions:
      - field: output.value
        operator: matches
        value: "(a+)+"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = veto.validateOutput('unsafe_tool', { value: 'aaaaaaaa' });

    expect(result.decision).toBe('allow');
    expect(result.matchedRuleIds).toHaveLength(0);
  });

  it('applies output rules only to matching tools', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: tool-specific-redact
    name: Tool specific redact
    enabled: true
    action: redact
    tools: [tool_a]
    output_conditions:
      - field: output.email
        operator: matches
        value: "[^@]+@[^@]+"
    redact_with: "[MASKED]"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = veto.validateOutput('tool_b', { email: 'alice@example.com' });

    expect(result.decision).toBe('allow');
    expect((result.output as any).email).toBe('alice@example.com');
    expect(result.matchedRuleIds).toHaveLength(0);
  });

  it('redacts wrapped tool output before returning to caller', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: wrap-redact
    name: Wrap redaction
    enabled: true
    action: redact
    tools: [get_profile]
    output_conditions:
      - field: output.email
        operator: matches
        value: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}"
    redact_with: "[EMAIL]"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const wrapped = veto.wrap([{
      name: 'get_profile',
      inputSchema: { type: 'object' },
      handler: async () => ({ email: 'alice@example.com' }),
    }]);

    const result = await wrapped[0].handler({});
    expect((result as any).email).toBe('[EMAIL]');
  });

  it('blocks wrapped tool output when output rule action is block', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: wrap-block
    name: Wrap blocking
    enabled: true
    action: block
    tools: [get_secret]
    description: Output blocked by policy
    output_conditions:
      - field: output.secret
        operator: contains
        value: token
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const wrapped = veto.wrap([{
      name: 'get_secret',
      inputSchema: { type: 'object' },
      handler: async () => ({ secret: 'api-token-123' }),
    }]);

    await expect(wrapped[0].handler({})).rejects.toThrow('Output blocked by policy');
  });
});
