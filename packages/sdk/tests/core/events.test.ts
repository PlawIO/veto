import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';
import { BudgetExceededError } from '../../src/core/budget.js';
import {
  formatCefPayload,
  formatGenericPayload,
  formatPagerDutyPayload,
  formatSlackPayload,
  redactEventArguments,
  type VetoWebhookEvent,
} from '../../src/core/events.js';

const TEST_DIR = `/tmp/veto-events-test-${Date.now()}`;
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');
const WEBHOOK_URL = 'https://hooks.example.com/veto';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function writeConfig(extra: string): void {
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
${extra}
`,
    'utf-8'
  );
}

function writeRules(content: string): void {
  writeFileSync(join(RULES_DIR, 'rules.yaml'), content, 'utf-8');
}

async function flushEventQueue(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('event webhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('format adapters', () => {
    const sampleEvent: VetoWebhookEvent = {
      eventType: 'deny',
      toolName: 'send_email',
      arguments: { to: 'team@example.com', subject: 'Status' },
      decision: 'deny',
      reason: 'Sensitive recipient blocked',
      ruleId: 'email-deny-001',
      severity: 'high',
      timestamp: '2026-02-22T10:00:00.000Z',
    };

    it('formats Slack payload using Block Kit blocks', () => {
      const payload = formatSlackPayload(sampleEvent);
      expect(payload).toMatchObject({
        text: expect.stringContaining('Veto deny'),
        blocks: expect.any(Array),
      });
    });

    it('formats PagerDuty payload in Events API v2 shape', () => {
      const payload = formatPagerDutyPayload(sampleEvent);
      expect(payload).toMatchObject({
        event_action: 'trigger',
        dedup_key: expect.stringContaining('veto-deny'),
        payload: {
          summary: expect.stringContaining('[Veto] deny'),
          source: 'veto-sdk',
          severity: 'error',
          custom_details: expect.objectContaining({
            event_type: 'deny',
            tool_name: 'send_email',
          }),
        },
      });
    });

    it('formats generic payload with all event fields', () => {
      const payload = formatGenericPayload(sampleEvent);
      expect(payload).toEqual({
        event_type: 'deny',
        tool_name: 'send_email',
        arguments: { to: 'team@example.com', subject: 'Status' },
        decision: 'deny',
        reason: 'Sensitive recipient blocked',
        rule_id: 'email-deny-001',
        severity: 'high',
        timestamp: '2026-02-22T10:00:00.000Z',
      });
    });

    it('formats CEF payload as a CEF string', () => {
      const payload = formatCefPayload(sampleEvent);
      expect(payload.startsWith('CEF:0|Veto|SDK|1.0|email-deny-001|')).toBe(true);
      expect(payload).toContain('eventType=deny');
      expect(payload).toContain('toolName=send_email');
    });
  });

  describe('argument redaction', () => {
    it('redacts all arguments when redactArguments is true', () => {
      const args = { to: 'team@example.com', subject: 'Status', body: 'Secret info' };
      const result = redactEventArguments(args, true);
      expect(result.to).toBe('[REDACTED]');
      expect(result.subject).toBe('[REDACTED]');
      expect(result.body).toBe('[REDACTED]');
    });

    it('redacts only specified keys when redactArguments is a string array', () => {
      const args = { to: 'team@example.com', subject: 'Status', body: 'Secret info' };
      const result = redactEventArguments(args, ['body', 'to']);
      expect(result.to).toBe('[REDACTED]');
      expect(result.subject).toBe('Status');
      expect(result.body).toBe('[REDACTED]');
    });

    it('returns args unchanged when no matching keys', () => {
      const args = { to: 'team@example.com' };
      const result = redactEventArguments(args, ['nonexistent']);
      expect(result.to).toBe('team@example.com');
    });

    it('does not mutate original args', () => {
      const args = { to: 'team@example.com', body: 'Secret' };
      redactEventArguments(args, ['body']);
      expect(args.body).toBe('Secret');
    });

    it('ignores prototype chain properties in selective redaction', () => {
      const args = { to: 'team@example.com' };
      const result = redactEventArguments(args, ['toString', 'constructor', 'to']);
      expect(result.to).toBe('[REDACTED]');
      expect(typeof result.toString).toBe('function');
      expect(result.toString()).not.toBe('[REDACTED]');
    });

    it('returns args unchanged when redact is false', () => {
      const args = { to: 'team@example.com' };
      expect(redactEventArguments(args, false as unknown as boolean)).toBe(args);
    });
  });

  it('fires webhook on deny event', async () => {
    writeConfig(`
events:
  webhook:
    url: "${WEBHOOK_URL}"
    on: ["deny"]
    min_severity: "info"
    format: "generic"
`);

    writeRules(`
version: "1.0"
name: deny-rules
rules:
  - id: deny-sensitive
    name: Deny sensitive path
    enabled: true
    severity: high
    action: block
    tools: [read_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc
`);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => '',
    });

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('read_file', { path: '/etc/passwd' });
    expect(result.decision).toBe('deny');

    await flushEventQueue();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event_type: 'deny',
      tool_name: 'read_file',
      decision: 'deny',
      rule_id: 'deny-sensitive',
      severity: 'high',
    });
  });

  it('does not fire webhook on allow when deny is the only configured event', async () => {
    writeConfig(`
events:
  webhook:
    url: "${WEBHOOK_URL}"
    on: ["deny"]
    min_severity: "info"
    format: "generic"
`);

    writeRules(`
version: "1.0"
name: allow-rules
rules:
  - id: allow-safe
    name: Allow safe path
    enabled: true
    severity: low
    action: allow
    tools: [read_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /tmp
`);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => '',
    });

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('read_file', { path: '/tmp/report.txt' });
    expect(result.decision).toBe('allow');

    await flushEventQueue();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies min_severity filtering', async () => {
    writeConfig(`
events:
  webhook:
    url: "${WEBHOOK_URL}"
    on: ["deny"]
    min_severity: "high"
    format: "generic"
`);

    writeRules(`
version: "1.0"
name: severity-rules
rules:
  - id: low-deny
    name: Low deny
    enabled: true
    severity: low
    action: block
    tools: [low_tool]
    conditions:
      - field: arguments.trigger
        operator: equals
        value: true
  - id: high-deny
    name: High deny
    enabled: true
    severity: high
    action: block
    tools: [high_tool]
    conditions:
      - field: arguments.trigger
        operator: equals
        value: true
`);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => '',
    });

    const veto = await Veto.init({ configDir: VETO_DIR });
    const lowResult = await veto.guard('low_tool', { trigger: true });
    const highResult = await veto.guard('high_tool', { trigger: true });
    expect(lowResult.decision).toBe('deny');
    expect(highResult.decision).toBe('deny');

    await flushEventQueue();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.severity).toBe('high');
    expect(payload.rule_id).toBe('high-deny');
  });

  it('does not block validation when webhook request fails', async () => {
    writeConfig(`
events:
  webhook:
    url: "${WEBHOOK_URL}"
    on: ["deny"]
    min_severity: "info"
    format: "generic"
`);

    writeRules(`
version: "1.0"
name: deny-rules
rules:
  - id: deny-sensitive
    name: Deny sensitive path
    enabled: true
    severity: high
    action: block
    tools: [read_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc
`);

    mockFetch.mockRejectedValue(new Error('webhook unavailable'));

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('read_file', { path: '/etc/passwd' });
    expect(result.decision).toBe('deny');

    await flushEventQueue();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fires budget_exceeded webhook event', async () => {
    writeConfig(`
budget:
  max: 10
  currency: "USD"
costs:
  charge_card: "args.amount"
events:
  webhook:
    url: "${WEBHOOK_URL}"
    on: ["budget_exceeded"]
    min_severity: "info"
    format: "generic"
`);

    writeRules(`
version: "1.0"
name: no-op-rules
rules: []
`);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => '',
    });

    const handler = vi.fn().mockResolvedValue('charged');
    const veto = await Veto.init({ configDir: VETO_DIR });
    const wrapped = veto.wrap([{ name: 'charge_card', handler }]);

    await wrapped[0].handler({ amount: 7 });
    await expect(wrapped[0].handler({ amount: 5 })).rejects.toBeInstanceOf(BudgetExceededError);

    await flushEventQueue();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event_type: 'budget_exceeded',
      tool_name: 'charge_card',
      decision: 'deny',
      severity: 'high',
    });
  });
});
