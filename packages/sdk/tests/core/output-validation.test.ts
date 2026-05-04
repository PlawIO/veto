import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = `/tmp/veto-output-validation-test-${Date.now()}`;
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

function writeConfig(
  mode: 'strict' | 'log' | 'shadow' = 'strict',
  piiConfig = ''
): void {
  writeFileSync(
    join(VETO_DIR, 'veto.config.yaml'),
    `
version: "1.0"
mode: "${mode}"
validation:
  mode: "local"
logging:
  level: "silent"
${piiConfig}
rules:
  directory: "./rules"
`,
    'utf-8'
  );
}

function writePolicy(content: string): void {
  writeFileSync(join(RULES_DIR, 'policy.yaml'), content, 'utf-8');
}

function mockNvidiaFetch(
  createEntities: (text: string) => unknown[]
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: { body?: unknown }) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ content?: string }>;
    };
    const text = requestBody.messages?.[0]?.content ?? '';
    const entities = createEntities(text);

    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              total_entities: entities.length,
              entities,
              tagged_text: '',
            }),
          },
        }],
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Veto output validation', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });
    vi.stubEnv('NVIDIA_API_KEY', '');
    vi.stubEnv('VETO_NVIDIA_API_KEY', '');
    vi.stubEnv('VETO_PII_ENABLED', '');
    vi.stubEnv('VETO_PII_PROVIDER', '');
    writeConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
      handler: async (_input: Record<string, unknown>) => ({ email: 'alice@example.com' }),
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
      handler: async (_input: Record<string, unknown>) => ({ secret: 'api-token-123' }),
    }]);

    await expect(wrapped[0].handler({})).rejects.toThrow('Output blocked by policy');
  });

  it.each(['log', 'shadow'] as const)(
    'does not block wrapped tool output in %s mode',
    async (mode) => {
      writeConfig(mode);
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
        handler: async (_input: Record<string, unknown>) => ({ secret: 'api-token-123' }),
      }]);

      await expect(wrapped[0].handler({})).resolves.toEqual({ secret: 'api-token-123' });
    }
  );

  it('does not mutate the caller output when cloning fails', async () => {
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: redact-secret
    name: Redact secret
    enabled: true
    action: redact
    tools: [report_tool]
    output_conditions:
      - field: output.note
        operator: matches
        value: SECRET
    redact_with: "[REDACTED]"
`
    );

    const veto = await Veto.init({ configDir: VETO_DIR });
    const output: Record<string, unknown> & { self?: unknown; fn?: () => string } = {
      note: 'contains SECRET value',
    };
    output.self = output;
    output.fn = () => 'noop';

    const result = veto.validateOutput('report_tool', output);

    expect(result.decision).toBe('allow');
    expect(result.redactions).toBe(0);
    expect(result.trace).toEqual([]);
    expect(result.output).toBe(output);
    expect(output.note).toBe('contains SECRET value');
  });

  it('redacts nested output with async NVIDIA GLiNER PII detection', async () => {
    writeConfig('strict', `pii:
  enabled: true
  provider: "nvidia-gliner-pii"
  apiKey: "test-nvidia-key"
  threshold: 0.4
  maxFields: 8
  maxTextChars: 1000`);
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: semantic-redact
    name: Semantic PII redaction
    enabled: true
    severity: high
    action: redact
    tools: [profile_tool]
    metadata:
      detector: "nvidia-gliner-pii"
      labels: [email, phone_number]
      threshold: 0.4
      fields: [output.profile.notes]
    redact_with: "[PII]"
`
    );

    const fetchMock = mockNvidiaFetch((text) => {
      const email = 'alice@example.com';
      const phone = '555-123-4567';
      return [
        { text: email, label: 'email', start: text.indexOf(email), end: text.indexOf(email) + email.length, score: 0.99 },
        { text: phone, label: 'phone_number', start: text.indexOf(phone), end: text.indexOf(phone) + phone.length, score: 0.97 },
      ];
    });

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.validateOutputAsync('profile_tool', {
      profile: {
        notes: 'Contact alice@example.com or 555-123-4567 for follow-up.',
      },
    });

    expect(result.decision).toBe('allow');
    expect((result.output as any).profile.notes).toBe('Contact [PII] or [PII] for follow-up.');
    expect(result.redactions).toBe(2);
    expect(result.matchedRuleIds).toContain('semantic-redact');
    expect(result.trace).toEqual([
      expect.objectContaining({
        ruleId: 'semantic-redact',
        field: 'output.profile.notes',
        pattern: 'nvidia-gliner-pii:email,phone_number',
        redactedCount: 2,
        replacement: '[PII]',
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks semantic detector matches without leaking raw entity values', async () => {
    writeConfig('strict', `pii:
  enabled: true
  provider: "nvidia-gliner-pii"
  apiKey: "test-nvidia-key"`);
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: semantic-block
    name: Semantic PII block
    description: PII detected in output
    enabled: true
    severity: critical
    action: block
    tools: [report_tool]
    metadata:
      detector: "nvidia/gliner-pii"
      labels: [email]
      fields: [output.message]
`
    );

    mockNvidiaFetch((text) => {
      const email = 'alice@example.com';
      return [{
        value: email,
        suggested_label: 'email',
        start_position: text.indexOf(email),
        end_position: text.indexOf(email) + email.length,
        score: 0.98,
      }];
    });

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.validateOutputAsync('report_tool', {
      message: 'Send the report to alice@example.com',
    });

    expect(result.decision).toBe('block');
    expect(result.output).toBeNull();
    expect(result.reason).toBe('PII detected in output');
    expect(result.matchedRuleIds).toContain('semantic-block');
    expect(JSON.stringify(result)).not.toContain('alice@example.com');
  });

  it('keeps semantic detector disabled without a key while regex fallback still works', async () => {
    writeConfig('strict', `pii:
  enabled: true
  provider: "nvidia-gliner-pii"`);
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: semantic-with-regex-fallback
    name: Semantic with regex fallback
    enabled: true
    severity: high
    action: redact
    tools: [profile_tool]
    output_conditions:
      - field: output.email
        operator: matches
        value: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\\\.[A-Za-z]{2,}"
    metadata:
      detector: "nvidia-gliner-pii"
      labels: [email]
    redact_with: "[EMAIL]"
`
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.validateOutputAsync('profile_tool', { email: 'alice@example.com' });

    expect(result.decision).toBe('allow');
    expect((result.output as any).email).toBe('[EMAIL]');
    expect(result.redactions).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps validateOutput synchronous and does not call fetch for semantic-only rules', async () => {
    writeConfig('strict', `pii:
  enabled: true
  provider: "nvidia-gliner-pii"
  apiKey: "test-nvidia-key"`);
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: semantic-only
    name: Semantic only
    enabled: true
    severity: high
    action: block
    tools: [profile_tool]
    metadata:
      detector: "nvidia-gliner-pii"
      labels: [email]
      fields: [output.email]
`
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = veto.validateOutput('profile_tool', { email: 'alice@example.com' });

    expect(result.decision).toBe('allow');
    expect((result.output as any).email).toBe('alice@example.com');
    expect(result.matchedRuleIds).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('awaits async semantic detector redaction in wrapped tools', async () => {
    writeConfig('strict', `pii:
  enabled: true
  provider: "nvidia-gliner-pii"
  apiKey: "test-nvidia-key"`);
    writePolicy(
      `
version: "1.0"
rules: []
output_rules:
  - id: semantic-wrap-redact
    name: Semantic wrapped redaction
    enabled: true
    severity: high
    action: redact
    tools: [get_profile]
    metadata:
      detector: "nvidia-gliner-pii"
      labels: [email]
      fields: [output.email]
    redact_with: "[EMAIL]"
`
    );

    mockNvidiaFetch((text) => {
      const email = 'alice@example.com';
      return [{ text: email, label: 'email', start: text.indexOf(email), end: text.indexOf(email) + email.length, score: 0.99 }];
    });

    const veto = await Veto.init({ configDir: VETO_DIR });
    const wrapped = veto.wrap([{
      name: 'get_profile',
      inputSchema: { type: 'object' },
      handler: async (_input: Record<string, unknown>) => ({ email: 'alice@example.com' }),
    }]);

    const result = await wrapped[0].handler({});
    expect((result as any).email).toBe('[EMAIL]');
  });

  it('records real output validation latency in cloud decision logs', async () => {
    const logDecision = vi.fn();
    const veto = Veto.fromRules({
      rules: [],
      outputRules: [
        {
          id: 'redact-secret',
          name: 'Redact secret',
          enabled: true,
          severity: 'medium',
          action: 'redact',
          tools: ['report_tool'],
          output_conditions: [
            {
              field: 'output.note',
              operator: 'matches',
              value: 'SECRET',
            },
          ],
          redact_with: '[REDACTED]',
        },
      ],
      cloudClient: {
        logDecision,
      } as any,
    });

    const originalDateNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return 100;
      if (callCount === 2) return 107;
      return originalDateNow();
    });

    await (veto as any).validateOutputOrThrow('report_tool', {}, { note: 'contains SECRET value' });

    expect(logDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        latency_ms: 7,
        decision: 'allow',
      })
    );
  });
});
