import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';
import { createLogger } from '../../src/utils/logger.js';

const TEST_DIR = '/tmp/veto-test-' + Date.now();
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

function writeLocalConfig(): void {
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

// Mock fetch for API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Veto', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Create test directory structure
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });

    // Create default config
    writeFileSync(
      join(VETO_DIR, 'veto.config.yaml'),
      `
version: "1.0"
mode: "strict"
validation:
  mode: "api"
api:
  baseUrl: "http://localhost:8080"
  endpoint: "/tool/call/check"
  timeout: 5000
  retries: 0
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
      'utf-8'
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('init', () => {
    it('should keep warnings and errors visible in stream mode', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const logger = createLogger('stream');

      logger.warn('Warn message', { component: 'sdk' });
      logger.error('Error message', { component: 'sdk' }, new Error('boom'));

      const output = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('WARN');
      expect(output).toContain('Warn message');
      expect(output).toContain('ERROR');
      expect(output).toContain('Error message');
      expect(output).toContain('boom');

      stderrSpy.mockRestore();
    });

    it('should initialize with config from directory', async () => {
      const veto = await Veto.init({ configDir: VETO_DIR });
      expect(veto).toBeInstanceOf(Veto);
    });

    it('should handle missing config gracefully', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      const veto = await Veto.init({ configDir: VETO_DIR });
      expect(veto).toBeInstanceOf(Veto);
    });

    it('should default to local mode with no config and make zero network calls', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));

      writeFileSync(
        join(RULES_DIR, 'local.yaml'),
        `
version: "1.0"
name: local-rules
rules:
  - id: local-block
    name: Local Block
    enabled: true
    action: block
    tools: [local_tool]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /tmp/blocked
`,
        'utf-8'
      );

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const handler = vi.fn();
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'local_tool', handler, inputSchema: {} }]);

      await expect(wrapped[0].handler({ path: '/tmp/blocked/file.txt' })).rejects.toThrow('Tool call denied');

      expect(handler).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Veto running in local mode'));
      infoSpy.mockRestore();
    });

    it('should prevent argument collisions from overriding local reserved fields', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));

      writeFileSync(
        join(RULES_DIR, 'collision.yaml'),
        `
version: "1.0"
name: collision-rules
rules:
  - id: collision-block
    name: Collision Block
    enabled: true
    action: block
    tools: [collision_tool]
    conditions:
      - field: tool_name
        operator: equals
        value: collision_tool
`,
        'utf-8'
      );

      const handler = vi.fn();
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'collision_tool', handler, inputSchema: {} }]);

      await expect(wrapped[0].handler({ tool_name: 'spoofed_name' })).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses custom guard context in local rule evaluation', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));

      writeFileSync(
        join(RULES_DIR, 'budget.yaml'),
        `
version: "1.0"
name: budget-rules
rules:
  - id: budget-block
    name: Budget Block
    enabled: true
    action: block
    tools: [trade]
    conditions:
      - field: budget.remaining
        operator: less_than
        value: 100
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('trade', { amount_usd: 40 }, {
        custom: {
          budget: {
            remaining: 80,
          },
        },
      });

      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('budget-block');
    });

    it('preserves reserved runtime context keys under arguments while keeping top-level market data namespaced', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'reserved-runtime-context.yaml'),
        `
version: "1.0"
name: reserved-runtime-context
rules:
  - id: reserved-runtime-context-block
    name: Reserved runtime context block
    enabled: true
    action: block
    tools: [trade]
    conditions:
      - field: arguments.market
        operator: equals
        value: BTC-USD
      - field: market.category
        operator: equals
        value: sports
      - field: budget.remaining
        operator: less_than
        value: 100
      - field: portfolio.positionCount
        operator: greater_than
        value: 0
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('trade', { market: 'BTC-USD' }, {
        market: { category: 'sports' },
        budget: { remaining: 50 },
        portfolio: { positionCount: 1 },
      });

      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('reserved-runtime-context-block');
    });

    it('logs when explicit runtime context overrides custom nested context keys', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      writeLocalConfig();

      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const veto = await Veto.init({ configDir: VETO_DIR, logLevel: 'debug' });
      await veto.guard('trade', {}, {
        custom: {
          market: { category: 'legacy' },
        },
        market: { category: 'sports' },
      });

      expect(debugSpy.mock.calls.some(([message]) =>
        String(message).includes('Guard context override applied')
        && String(message).includes('"key":"market"')
      )).toBe(true);

      debugSpy.mockRestore();
    });

    it('prevents custom guard context from overriding raw local argument fields', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'raw-amount.yaml'),
        `
version: "1.0"
name: raw-amount-rules
rules:
  - id: raw-amount-block
    name: Raw Amount Block
    enabled: true
    action: block
    tools: [trade]
    conditions:
      - field: amount_usd
        operator: greater_than
        value: 100
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('trade', { amount_usd: 50 }, {
        custom: {
          amount_usd: 500,
        },
      });

      expect(result.decision).toBe('allow');
    });

    it('does not emit non-blocking local log side effects when a block rule is decisive', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));

      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "warn"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'mixed-actions.yaml'),
        `
version: "1.0"
name: mixed-actions
rules:
  - id: warn-trade
    name: Warn trade
    enabled: true
    action: warn
    tools: [trade]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 100
  - id: block-trade
    name: Block trade
    enabled: true
    action: block
    tools: [trade]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 100
`,
        'utf-8'
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const veto = await Veto.init({ configDir: VETO_DIR });
        const result = await veto.guard('trade', { amount_usd: 150 });

        expect(result.decision).toBe('deny');

        const messages = warnSpy.mock.calls.map(([message]) => String(message));
        expect(messages.some((message) => message.includes('Local rule matched with non-blocking action'))).toBe(false);
        expect(messages.some((message) => message.includes('Tool call blocked by local rule'))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('reloads local rules after new files are written', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      writeLocalConfig();

      const veto = await Veto.init({ configDir: VETO_DIR });
      const before = await veto.guard('trade', { amount_usd: 150 });
      expect(before.decision).toBe('allow');

      writeFileSync(
        join(RULES_DIR, 'new-rule.yaml'),
        `
version: "1.0"
name: dynamic-rules
rules:
  - id: dynamic-block
    name: Dynamic Block
    enabled: true
    action: block
    tools: [trade]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 100
`,
        'utf-8'
      );

      await veto.reloadLocalRules();
      const after = await veto.guard('trade', { amount_usd: 150 });

      expect(after.decision).toBe('deny');
      expect(after.ruleId).toBe('dynamic-block');
    });

    it('prefers the most restrictive matching local rule', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'precedence.yaml'),
        `
version: "1.0"
name: precedence-rules
rules:
  - id: allow-small-trades
    name: Allow small trades
    enabled: true
    action: allow
    tools: [trade]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 10
  - id: require-review
    name: Require review
    enabled: true
    action: require_approval
    tools: [trade]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 10
  - id: block-trade
    name: Block trade
    enabled: true
    action: block
    tools: [trade]
    conditions:
      - field: arguments.amount_usd
        operator: greater_than
        value: 10
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('trade', { amount_usd: 50 });

      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('block-trade');
    });

    it('should auto-detect cloud mode when apiKey is provided', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const veto = await Veto.init({
        configDir: VETO_DIR,
        apiKey: 'veto_test_key',
        logLevel: 'info',
      });

      const tools = [{ name: 'cloud_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.veto.so/v1/tools/validate'),
        expect.any(Object)
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Veto running in cloud mode'));
      infoSpy.mockRestore();
    });

    it('should auto-detect self-hosted mode when endpoint is provided', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const endpoint = 'https://self-hosted.example.com';
      const veto = await Veto.init({
        configDir: VETO_DIR,
        endpoint,
        logLevel: 'info',
      });

      const tools = [{ name: 'self_hosted_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`${endpoint}/v1/tools/validate`),
        expect.any(Object)
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Veto running in self-hosted mode'));
      infoSpy.mockRestore();
    });

    it('should warn and use self-hosted mode when endpoint and apiKey are both provided', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const endpoint = 'https://self-hosted.example.com';
      const veto = await Veto.init({
        configDir: VETO_DIR,
        endpoint,
        apiKey: 'veto_test_key',
        logLevel: 'warn',
      });

      const tools = [{ name: 'mixed_mode_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`${endpoint}/v1/tools/validate`),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Veto-API-Key': 'veto_test_key',
          }),
        })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Both endpoint and apiKey provided. Using self-hosted mode')
      );
      warnSpy.mockRestore();
    });

    it('should load rules from directory', async () => {
      // Create a rule
      writeFileSync(
        join(RULES_DIR, 'test.yaml'),
        `
version: "1.0"
name: test-rules
rules:
  - id: test-rule
    name: Test Rule
    enabled: true
    action: block
    tools: [test_tool]
`,
        'utf-8'
      );

      await Veto.init({ configDir: VETO_DIR });
      // Logic for verifying rules loaded is indirect via usage below
    });

    it('should inherit rules from a built-in pack with extends', async () => {
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'extends-pack.yaml'),
        `
version: "1.0"
extends: "@veto/coding-agent"
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('run_shell', { command: 'rm -rf /tmp' });

      expect(result.decision).toBe('deny');
      expect(result.ruleId).toBe('coding-agent-block-dangerous-shell-commands');
    });

    it('should allow overriding a pack rule by id', async () => {
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'override-pack.yaml'),
        `
version: "1.0"
extends: "@veto/coding-agent"
rules:
  - id: coding-agent-block-dangerous-shell-commands
    name: Override dangerous shell detection
    action: block
    tools: [run_shell]
    conditions:
      - field: arguments.command
        operator: contains
        value: shutdown
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('run_shell', { command: 'rm -rf /tmp' });

      expect(result.decision).toBe('allow');
    });

    it('should append custom rules alongside inherited pack rules', async () => {
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'append-pack.yaml'),
        `
version: "1.0"
extends: "@veto/coding-agent"
rules:
  - id: custom-block-prod-path
    name: Custom block for prod paths
    action: block
    tools: [write_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /prod
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const inherited = await veto.guard('run_shell', { command: 'rm -rf /tmp' });
      const custom = await veto.guard('write_file', { path: '/prod/app.env' });

      expect(inherited.decision).toBe('deny');
      expect(inherited.ruleId).toBe('coding-agent-block-dangerous-shell-commands');
      expect(custom.decision).toBe('deny');
      expect(custom.ruleId).toBe('custom-block-prod-path');
    });

    it('should skip invalid extends packs without crashing initialization', async () => {
      writeLocalConfig();

      writeFileSync(
        join(RULES_DIR, 'bad-pack.yaml'),
        `
version: "1.0"
extends: "@veto/does-not-exist"
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('run_shell', { command: 'rm -rf /tmp' });

      expect(result.decision).toBe('allow');
    });
  });

  describe('wrap', () => {
    it('should wrap tools and preserve execution', async () => {
      const handler = vi.fn().mockResolvedValue('result');
      const tools = [{
        name: 'test_tool',
        description: 'Test tool',
        handler,
        inputSchema: {}
      }];

      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap(tools);

      expect(wrapped).toHaveLength(1);
      expect(wrapped[0].name).toBe('test_tool');

      // Execute
      const result = await wrapped[0].handler({});
      expect(result).toBe('result');
      expect(handler).toHaveBeenCalled();
    });

    it('should block execution when rule matches and API blocks', async () => {
      // Setup rule
      const rulePath = join(RULES_DIR, 'block.yaml');
      writeFileSync(
        rulePath,
        `
version: "1.0"
name: block-rules
rules:
  - id: block-rule
    name: Block Rule
    enabled: true
    action: block
    tools: [blocked_tool]
`,
        'utf-8'
      );

      // Mock API block response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'block',
          reasoning: 'Blocked by test',
          should_block_weight: 1
        }),
      });

      const handler = vi.fn();
      const tools = [{
        name: 'blocked_tool',
        description: 'Blocked',
        handler,
        inputSchema: {}
      }];

      const veto = await Veto.init({
        configDir: VETO_DIR,
        logLevel: 'debug'
      });
      const wrapped = veto.wrap(tools);

      // Execute -> Should throw
      try {
        await wrapped[0].handler({});
        // If we reach here, fail
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain('Tool call denied');
      }
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    it('should track allowed and blocked calls', async () => {
      // Setup: 1 allow, 1 block
      const rulePath = join(RULES_DIR, 'history-rules.yaml');
      writeFileSync(
        rulePath,
        `
version: "1.0"
name: history-rules
rules:
  - id: block
    name: Block
    enabled: true
    action: block
    tools: [blocked_tool]
`,
        'utf-8'
      );

      // Call 1: Allow (no rules for allowed_tool)
      // Call 2: Block (rule for blocked_tool + API block)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'block',
          reasoning: 'blocked',
          should_block_weight: 1
        })
      });

      const tools = [
        { name: 'allowed_tool', handler: async () => 'ok', inputSchema: {} },
        { name: 'blocked_tool', handler: async () => 'ok', inputSchema: {} }
      ];

      const veto = await Veto.init({ configDir: VETO_DIR, logLevel: 'debug' });
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler(); // Should pass

      try {
        await wrapped[1].handler();
      } catch {
        // Expected to throw
      }

      const stats = veto.getHistoryStats();
      console.log('History stats:', stats);

      // allowed_tool allows -> 1 allowed
      // blocked_tool denies -> 1 denied
      expect(stats.totalCalls).toBe(2);
      expect(stats.allowedCalls).toBe(1);
      expect(stats.deniedCalls).toBe(1);
    });

    it('should clear history', async () => {
      const veto = await Veto.init({ configDir: VETO_DIR });
      const tools = [{ name: 't', handler: async () => 'ok', inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler();
      expect(veto.getHistoryStats().totalCalls).toBe(1);

      veto.clearHistory();
      expect(veto.getHistoryStats().totalCalls).toBe(0);
    });

    it('should export decision history as JSON and CSV', async () => {
      const veto = await Veto.init({ configDir: VETO_DIR });
      const tools = [{
        name: 'history_export_tool',
        handler: async (_args: Record<string, unknown>) => 'ok',
        inputSchema: {},
      }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ amount: 42 });

      const exportedJson = JSON.parse(veto.exportDecisions('json'));
      expect(exportedJson).toHaveLength(1);
      expect(exportedJson[0]).toMatchObject({
        tool_name: 'history_export_tool',
        arguments: { amount: 42 },
        decision: 'allow',
      });

      const exportedCsv = veto.exportDecisions('csv');
      const lines = exportedCsv.split('\n');
      expect(lines[0]).toBe('timestamp,tool_name,arguments,policy_version,rule_id,decision,reason');
      expect(lines[1]).toContain('history_export_tool');
    });
  });

  describe('guard', () => {
    it('should return allow decision and record history', async () => {
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

      writeFileSync(
        join(RULES_DIR, 'allow.yaml'),
        `
version: "1.0"
rules:
  - id: allow-safe
    name: Allow safe calls
    description: Safe call allowed
    enabled: true
    severity: low
    action: allow
    tools: [safe_tool]
    conditions:
      - field: arguments.level
        operator: equals
        value: safe
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('safe_tool', { level: 'safe' });

      expect(result).toMatchObject({
        decision: 'allow',
        reason: 'Safe call allowed',
        ruleId: 'allow-safe',
        severity: 'low',
      });
      expect(veto.getHistoryStats().totalCalls).toBe(1);
    });

    it('should return deny decision for block rules', async () => {
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

      writeFileSync(
        join(RULES_DIR, 'deny.yaml'),
        `
version: "1.0"
rules:
  - id: block-sensitive
    name: Block sensitive calls
    description: Blocked by local policy
    enabled: true
    severity: high
    action: block
    tools: [sensitive_tool]
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('sensitive_tool', { target: 'prod' });

      expect(result).toMatchObject({
        decision: 'deny',
        reason: 'Blocked by local policy',
        ruleId: 'block-sensitive',
        severity: 'high',
      });
    });

    it('should return require_approval for local approval rules', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
approval:
  callbackUrl: "http://localhost:9999/approvals"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'local-approval.yaml'),
        `
version: "1.0"
rules:
  - id: local-approval
    name: Local approval required
    description: Needs human review
    enabled: true
    severity: critical
    action: require_approval
    tools: [wire_transfer]
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('wire_transfer', { amount: 25000 });

      expect(result).toMatchObject({
        decision: 'require_approval',
        reason: 'Needs human review',
        ruleId: 'local-approval',
        severity: 'critical',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return require_approval with approvalId in cloud mode', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Cloud approval required',
          approval_id: 'appr-guard-001',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('cloud_sensitive_tool', { amount: 5000 });

      expect(result).toMatchObject({
        decision: 'require_approval',
        reason: 'Cloud approval required',
        approvalId: 'appr-guard-001',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should default to allow when no rules apply', async () => {
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

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('unconfigured_tool', { any: 'value' });

      expect(result.decision).toBe('allow');
    });

    it('should return deny in log mode when the policy would block', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "log"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'log-block.yaml'),
        `
version: "1.0"
rules:
  - id: log-mode-block
    name: Log mode block
    description: Should still deny for guard
    enabled: true
    severity: medium
    action: block
    tools: [dangerous_tool]
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      const result = await veto.guard('dangerous_tool', { action: 'drop' });

      expect(result).toMatchObject({
        decision: 'deny',
        reason: 'Should still deny for guard',
        ruleId: 'log-mode-block',
      });
    });

    it('should allow per-call session and agent context overrides', async () => {
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

      writeFileSync(
        join(RULES_DIR, 'context.yaml'),
        `
version: "1.0"
rules:
  - id: context-block
    name: Context-aware block
    enabled: true
    severity: high
    action: block
    tools: [contextual_tool]
    conditions:
      - field: session_id
        operator: equals
        value: override-session
      - field: agent_id
        operator: equals
        value: override-agent
`,
        'utf-8'
      );

      const veto = await Veto.init({
        configDir: VETO_DIR,
        sessionId: 'default-session',
        agentId: 'default-agent',
      });

      const defaultResult = await veto.guard('contextual_tool', {});
      expect(defaultResult.decision).toBe('allow');

      const overriddenResult = await veto.guard('contextual_tool', {}, {
        sessionId: 'override-session',
        agentId: 'override-agent',
      });
      expect(overriddenResult.decision).toBe('deny');
      expect(overriddenResult.ruleId).toBe('context-block');
    });
  });

  describe('Local require_approval action', () => {
    it('should allow execution when callback approves', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
approval:
  callbackUrl: "http://localhost:9001/approvals"
  timeout: 100
  timeoutBehavior: "block"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'approval.yaml'),
        `
version: "1.0"
rules:
  - id: require-bank-transfer-approval
    name: Require bank transfer approval
    enabled: true
    action: require_approval
    tools: [bank_transfer]
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ decision: 'approved', reason: 'Approved by treasury lead' }),
        text: async () =>
          JSON.stringify({ decision: 'approved', reason: 'Approved by treasury lead' }),
      });

      const handler = vi.fn().mockResolvedValue('transfer-complete');
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'bank_transfer', handler, inputSchema: {} }]);

      const result = await wrapped[0].handler({ amount: 25000, recipient: 'vendor-123' });

      expect(result).toBe('transfer-complete');
      expect(handler).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9001/approvals',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should deny execution when callback denies', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
approval:
  callbackUrl: "http://localhost:9001/approvals"
  timeout: 100
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'approval.yaml'),
        `
version: "1.0"
rules:
  - id: require-bank-transfer-approval
    name: Require bank transfer approval
    enabled: true
    action: require_approval
    tools: [bank_transfer]
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ decision: 'deny', reason: 'Approval denied by reviewer' }),
        text: async () =>
          JSON.stringify({ decision: 'deny', reason: 'Approval denied by reviewer' }),
      });

      const handler = vi.fn();
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'bank_transfer', handler, inputSchema: {} }]);

      await expect(wrapped[0].handler({ amount: 25000 })).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should block by default on approval timeout', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
approval:
  callbackUrl: "http://localhost:9001/approvals"
  timeout: 20
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'approval.yaml'),
        `
version: "1.0"
rules:
  - id: require-bank-transfer-approval
    name: Require bank transfer approval
    enabled: true
    action: require_approval
    tools: [bank_transfer]
`,
        'utf-8'
      );

      mockFetch.mockImplementationOnce(
        () => new Promise(() => {})
      );

      const handler = vi.fn();
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'bank_transfer', handler, inputSchema: {} }]);

      await expect(wrapped[0].handler({ amount: 25000 })).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should allow on timeout when timeoutBehavior is allow', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
approval:
  callbackUrl: "http://localhost:9001/approvals"
  timeout: 20
  timeoutBehavior: "allow"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      writeFileSync(
        join(RULES_DIR, 'approval.yaml'),
        `
version: "1.0"
rules:
  - id: require-bank-transfer-approval
    name: Require bank transfer approval
    enabled: true
    action: require_approval
    tools: [bank_transfer]
`,
        'utf-8'
      );

      mockFetch.mockImplementationOnce(
        () => new Promise(() => {})
      );

      const handler = vi.fn().mockResolvedValue('transfer-complete');
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'bank_transfer', handler, inputSchema: {} }]);

      const result = await wrapped[0].handler({ amount: 25000 });
      expect(result).toBe('transfer-complete');
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('Integration: Kernel Mode', () => {
    it('should use kernel client for validation', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "kernel"
logging:
  level: "debug"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      // Create rule to trigger validation
      const rulePath = join(RULES_DIR, 'k-rule.yaml');
      writeFileSync(rulePath, `
version: "1.0"
name: kernel-rules
rules:
  - id: k-rule
    name: K Rule
    enabled: true
    action: block
    tools: [k_tool]
`);

      const mockKernelClient = {
        evaluate: vi.fn().mockResolvedValue({
          decision: 'block',
          reasoning: 'Kernel blocked',
          block_weight: 1.0,
          pass_weight: 0.0
        }),
        healthCheck: vi.fn().mockResolvedValue(true)
      };

      const veto = await Veto.init({
        configDir: VETO_DIR,
        kernelClient: mockKernelClient as never
      });

      const tools = [{ name: 'k_tool', handler: vi.fn(), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      try {
        await wrapped[0].handler({});
        expect(true).toBe(false); // Fail if no throw
      } catch (error: any) {
        expect(error.message).toContain('Kernel blocked') // Or 'Tool call denied'
      }
      expect(mockKernelClient.evaluate).toHaveBeenCalled();
    });
  });

  describe('Integration: Cloud Mode', () => {
    it('should allow tool call when cloud returns allow', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const tools = [{ name: 'test_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({ query: 'test' });
      expect(result).toBe('ok');
    });

    it('should cache output rules from cloud validation and redact tool output', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            decision: 'allow',
            reason: 'Allowed',
            outputRules: [
              {
                id: 'redact-acme',
                name: 'Hide Acme',
                enabled: true,
                severity: 'high',
                action: 'redact',
                tools: ['google_sheets_read'],
                output_conditions: [
                  {
                    field: 'output.company',
                    operator: 'matches',
                    value: '(?i)\\bacme\\b(?:\\s+(?:inc|corp|llc))?\\.?',
                  },
                ],
                redact_with: '[REDACTED]',
              },
            ],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
          text: async () => '',
        });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn().mockResolvedValue({ company: 'Acme Inc.' });
      const tools = [{ name: 'google_sheets_read', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({ sheet: 'pipeline' });

      expect(result).toEqual({ company: '[REDACTED]' });
    });

    it('clears cached remote output rules when a later cloud response omits outputRules', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            decision: 'allow',
            reason: 'Allowed',
            outputRules: [
              {
                id: 'redact-acme',
                name: 'Hide Acme',
                enabled: true,
                severity: 'high',
                action: 'redact',
                tools: ['google_sheets_read'],
                output_conditions: [
                  {
                    field: 'output.company',
                    operator: 'matches',
                    value: '(?i)\\bacme\\b',
                  },
                ],
                redact_with: '[REDACTED]',
              },
            ],
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            decision: 'allow',
            reason: 'Allowed again',
          }),
          text: async () => '',
        });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn()
        .mockResolvedValueOnce({ company: 'Acme Inc.' })
        .mockResolvedValueOnce({ company: 'Acme Inc.' });
      const tools = [{ name: 'google_sheets_read', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const firstResult = await wrapped[0].handler({ sheet: 'pipeline' });
      const secondResult = await wrapped[0].handler({ sheet: 'pipeline' });

      expect(firstResult).toEqual({ company: '[REDACTED] Inc.' });
      expect(secondResult).toEqual({ company: 'Acme Inc.' });
    });

    it('does not try to create a cloud client while logging output validation without one', async () => {
      writeLocalConfig();

      const veto = await Veto.init({ configDir: VETO_DIR });
      const getCloudClientSpy = vi
        .spyOn(veto as any, 'getCloudClient')
        .mockImplementation(() => {
          throw new Error('getCloudClient should not be called');
        });

      (veto as any).validationMode = 'cloud';
      (veto as any).cloudClient = undefined;

      expect(() => (veto as any).logOutputValidation('report_tool', {}, {
        decision: 'allow',
        output: { value: 'redacted' },
        matchedRuleIds: ['rule-1'],
        redactions: 1,
        trace: [
          {
            ruleId: 'rule-1',
            ruleName: 'Hide secret',
            field: 'output',
            pattern: '(?i)secret',
            redactedCount: 1,
            replacement: '[REDACTED]',
          },
        ],
      })).not.toThrow();

      expect(getCloudClientSpy).not.toHaveBeenCalled();
    });

    it('should deny tool call when cloud returns deny', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'deny', reason: 'Blocked by policy' }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn();
      const tools = [{ name: 'blocked', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should poll approval and allow when approved', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
  timeout: 5000
logging:
  level: "silent"
`,
        'utf-8'
      );

      // First fetch: validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-001',
        }),
        text: async () => '',
      });

      // Second fetch: poll returns approved
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-001',
          status: 'approved',
          resolvedBy: 'admin@corp.com',
          toolName: 'sensitive_tool',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn().mockResolvedValue('executed');
      const tools = [{ name: 'sensitive_tool', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({ data: 'sensitive' });
      expect(result).toBe('executed');
      expect(handler).toHaveBeenCalled();
    });

    it('should poll approval and deny when denied', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
  timeout: 5000
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-002',
        }),
        text: async () => '',
      });

      // poll returns denied
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-002',
          status: 'denied',
          resolvedBy: 'admin',
          toolName: 'dangerous',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn();
      const tools = [{ name: 'dangerous', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should deny when approval times out', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
  timeout: 50
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Review needed',
          approval_id: 'appr-003',
        }),
        text: async () => '',
      });

      // Poll always returns pending
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'appr-003',
          status: 'pending',
          toolName: 'test',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn();
      const tools = [{ name: 'test', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should fire onApprovalRequired hook', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs human',
          approval_id: 'appr-004',
        }),
        text: async () => '',
      });

      // poll returns approved
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-004',
          status: 'approved',
          resolvedBy: 'user',
          toolName: 'tool',
        }),
        text: async () => '',
      });

      const onApprovalRequired = vi.fn();

      const veto = await Veto.init({
        configDir: VETO_DIR,
        onApprovalRequired,
      });

      const tools = [{ name: 'tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({});

      expect(onApprovalRequired).toHaveBeenCalledOnce();
      expect(onApprovalRequired).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'tool' }),
        'appr-004'
      );
    });
  });

  describe('wrapMCPTools', () => {
    it('should wrap MCP tools and validate before calling server', async () => {
      const mcpTools = [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ];

      const mockServerClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'file contents' }],
        }),
      };

      const veto = await Veto.init({ configDir: VETO_DIR });
      const { tools, callTool } = veto.wrapMCPTools(mcpTools, mockServerClient);

      // Original tools are returned unmodified
      expect(tools).toBe(mcpTools);
      expect(tools).toHaveLength(1);

      // callTool validates and forwards
      const result = await callTool({ name: 'read_file', arguments: { path: '/tmp/test.txt' } });
      expect(result.content[0].text).toBe('file contents');
      expect(mockServerClient.callTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: '/tmp/test.txt' },
      });
    });

    it('should block MCP tool call when validation denies', async () => {
      const rulePath = join(RULES_DIR, 'mcp-block.yaml');
      writeFileSync(rulePath, `
version: "1.0"
name: mcp-block
rules:
  - id: block-read
    name: Block read_file
    enabled: true
    action: block
    tools: [read_file]
`);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'block',
          reasoning: 'Blocked by policy',
          should_block_weight: 1,
        }),
      });

      const mcpTools = [
        {
          name: 'read_file',
          inputSchema: { type: 'object' as const },
        },
      ];

      const mockServerClient = {
        callTool: vi.fn(),
      };

      const veto = await Veto.init({ configDir: VETO_DIR });
      const { callTool } = veto.wrapMCPTools(mcpTools, mockServerClient);

      await expect(callTool({ name: 'read_file', arguments: { path: '/etc/passwd' } }))
        .rejects.toThrow('Tool call denied');
      expect(mockServerClient.callTool).not.toHaveBeenCalled();
    });

    it('should handle callTool without arguments', async () => {
      const mcpTools = [
        {
          name: 'list_tools',
          inputSchema: { type: 'object' as const },
        },
      ];

      const mockServerClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '[]' }],
        }),
      };

      const veto = await Veto.init({ configDir: VETO_DIR });
      const { callTool } = veto.wrapMCPTools(mcpTools, mockServerClient);

      const result = await callTool({ name: 'list_tools' });
      expect(result.content[0].text).toBe('[]');
      expect(mockServerClient.callTool).toHaveBeenCalledWith({
        name: 'list_tools',
        arguments: {},
      });
    });
  });

  describe('Approval Preferences', () => {
    it('should auto-approve when approve_all preference is set', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-pref-001',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      veto.setApprovalPreference('pref_tool', 'approve_all');

      const handler = vi.fn().mockResolvedValue('auto-approved');
      const tools = [{ name: 'pref_tool', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({});
      expect(result).toBe('auto-approved');
      expect(handler).toHaveBeenCalled();
      // Only the validate call should have been made, no poll call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should auto-deny when deny_all preference is set', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-pref-002',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      veto.setApprovalPreference('deny_tool', 'deny_all');

      const handler = vi.fn();
      const tools = [{ name: 'deny_tool', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
      // Only the validate call, no poll
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should clear preferences', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
logging:
  level: "silent"
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });

      veto.setApprovalPreference('tool_a', 'approve_all');
      veto.setApprovalPreference('tool_b', 'deny_all');

      expect(veto.getApprovalPreference('tool_a')).toBe('approve_all');
      expect(veto.getApprovalPreference('tool_b')).toBe('deny_all');

      // Clear specific
      veto.clearApprovalPreferences('tool_a');
      expect(veto.getApprovalPreference('tool_a')).toBeUndefined();
      expect(veto.getApprovalPreference('tool_b')).toBe('deny_all');

      // Clear all
      veto.clearApprovalPreferences();
      expect(veto.getApprovalPreference('tool_b')).toBeUndefined();
    });
  });
});
