import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Veto,
  ToolCallDeniedError,
  wrapAction,
} from '../index.js';
import {
  protect as browserProtect,
  __resetProtectCacheForTests,
} from '../protect.js';
import type { OutputRule, Rule } from '../../rules/types.js';

const fetchMock = vi.fn();

function createNavigateBlockRule(): Rule {
  return {
    id: 'block-sensitive-url',
    name: 'Block Sensitive URL',
    enabled: true,
    severity: 'high',
    action: 'block',
    tools: ['navigate'],
    conditions: [
      {
        field: 'arguments.url',
        operator: 'contains',
        value: 'bank',
      },
    ],
  };
}

describe('browser entry', () => {
  beforeEach(() => {
    __resetProtectCacheForTests();
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => '',
    });
    global.fetch = fetchMock as typeof global.fetch;
  });

  afterEach(() => {
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
  });

  it('constructs from rules without filesystem access', () => {
    const originalProcess = globalThis.process;
    Reflect.deleteProperty(globalThis, 'process');

    try {
      expect(() => Veto.fromRules({
        rules: [createNavigateBlockRule()],
        logLevel: 'silent',
      })).not.toThrow();
    } finally {
      globalThis.process = originalProcess;
    }
  });

  it('guard validates tool calls against inline rules', async () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      logLevel: 'silent',
    });

    const result = await veto.guard('navigate', { url: 'https://bank.example.com' });

    expect(result.decision).toBe('deny');
    expect(result.ruleId).toBe('block-sensitive-url');
    expect(result.severity).toBe('high');
  });

  it('guard returns deny for matching block rules', async () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      logLevel: 'silent',
    });

    const result = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(result.decision).toBe('deny');
  });

  it('guard returns allow for non-matching rules', async () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      logLevel: 'silent',
    });

    const result = await veto.guard('navigate', { url: 'https://example.com' });
    expect(result.decision).toBe('allow');
  });

  it('guard returns require_approval when configured', async () => {
    const veto = Veto.fromRules({
      rules: [
        {
          id: 'require-approval-transfer',
          name: 'Require Approval Transfer',
          enabled: true,
          severity: 'critical',
          action: 'require_approval',
          tools: ['transfer'],
          conditions: [
            {
              field: 'arguments.amount',
              operator: 'greater_than',
              value: 1000,
            },
          ],
        },
      ],
      logLevel: 'silent',
    });

    const result = await veto.guard('transfer', { amount: 2500 });
    expect(result.decision).toBe('require_approval');
  });

  it('validateOutput works with inline output rules', () => {
    const outputRules: OutputRule[] = [
      {
        id: 'block-secret-output',
        name: 'Block Secret Output',
        enabled: true,
        severity: 'high',
        action: 'block',
        tools: ['report'],
        output_conditions: [
          {
            field: 'output.message',
            operator: 'contains',
            value: 'SECRET',
          },
        ],
      },
    ];
    const veto = Veto.fromRules({
      rules: [],
      outputRules,
      logLevel: 'silent',
    });

    const result = veto.validateOutput('report', { message: 'contains SECRET value' });
    expect(result.decision).toBe('block');
  });

  it('redacts output using regex-based output rules', () => {
    const outputRules: OutputRule[] = [
      {
        id: 'redact-ssn',
        name: 'Redact SSN',
        enabled: true,
        severity: 'high',
        action: 'redact',
        tools: ['submit_form'],
        output_conditions: [
          {
            field: 'output.value',
            operator: 'matches',
            value: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
          },
        ],
        redact_with: '[REDACTED]',
      },
    ];
    const veto = Veto.fromRules({
      rules: [],
      outputRules,
      logLevel: 'silent',
    });

    const result = veto.validateOutput('submit_form', { value: '123-45-6789' });
    expect(result.decision).toBe('allow');
    expect((result.output as { value: string }).value).toBe('[REDACTED]');
  });

  it('applies agent-scoped rules', async () => {
    const veto = Veto.fromRules({
      rules: [
        {
          id: 'agent-specific-block',
          name: 'Agent Specific Block',
          enabled: true,
          severity: 'medium',
          action: 'block',
          tools: ['navigate'],
          agents: ['agent-a'],
          conditions: [
            {
              field: 'arguments.url',
              operator: 'contains',
              value: 'internal',
            },
          ],
        },
      ],
      logLevel: 'silent',
    });

    const blocked = await veto.guard(
      'navigate',
      { url: 'https://internal.example.com' },
      { agentId: 'agent-a' }
    );
    const allowed = await veto.guard(
      'navigate',
      { url: 'https://internal.example.com' },
      { agentId: 'agent-b' }
    );

    expect(blocked.decision).toBe('deny');
    expect(allowed.decision).toBe('allow');
  });

  it('supports condition groups with OR semantics', async () => {
    const veto = Veto.fromRules({
      rules: [
        {
          id: 'condition-groups-or',
          name: 'Condition Groups OR',
          enabled: true,
          severity: 'high',
          action: 'block',
          tools: ['navigate'],
          condition_groups: [
            [
              {
                field: 'arguments.url',
                operator: 'contains',
                value: 'admin',
              },
            ],
            [
              {
                field: 'arguments.url',
                operator: 'contains',
                value: 'bank',
              },
            ],
          ],
        },
      ],
      logLevel: 'silent',
    });

    const result = await veto.guard('navigate', { url: 'https://example.com/admin' });
    expect(result.decision).toBe('deny');
  });

  it('tracks budget across multiple wrapped calls', async () => {
    const veto = Veto.fromRules({
      rules: [],
      logLevel: 'silent',
      budget: {
        max: 10,
        currency: 'USD',
      },
      costs: {
        send_email: 6,
      },
    });

    const wrapped = veto.wrap([{
      name: 'send_email',
      handler: async () => 'ok',
      inputSchema: {},
    }]);

    await wrapped[0].handler({ to: 'a@example.com' });
    const firstStatus = veto.getBudgetStatus();
    expect(firstStatus?.spent).toBe(6);

    await expect(
      wrapped[0].handler({ to: 'b@example.com' })
    ).rejects.toThrow('Budget exceeded');

    const secondStatus = veto.getBudgetStatus();
    expect(secondStatus?.spent).toBe(6);
  });

  it('records history for guard decisions', async () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      logLevel: 'silent',
    });

    await veto.guard('navigate', { url: 'https://bank.example.com' });
    await veto.guard('navigate', { url: 'https://example.com' });

    const stats = veto.getHistoryStats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.deniedCalls).toBe(1);
    expect(stats.allowedCalls).toBe(1);
  });

  it('throws ToolCallDeniedError from wrap() on deny', async () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      logLevel: 'silent',
    });

    const wrapped = veto.wrap([{
      name: 'navigate',
      handler: async () => 'ok',
      inputSchema: {},
    }]);

    await expect(
      wrapped[0].handler({ url: 'https://bank.example.com' })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('allows wrap execution in shadow mode while preserving deny decision in guard', async () => {
    const handler = vi.fn(async () => 'navigated');
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      mode: 'shadow',
      logLevel: 'silent',
    });

    const guardResult = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(guardResult.decision).toBe('deny');
    expect(guardResult.shadow).toBe(true);
    expect(guardResult.shadowDecision).toBe('deny');

    const wrapped = veto.wrap([{
      name: 'navigate',
      handler,
      inputSchema: {},
    }]);

    await expect(
      wrapped[0].handler({ url: 'https://bank.example.com' })
    ).resolves.toBe('navigated');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves require_approval decision in wrapAction errors', async () => {
    const veto = Veto.fromRules({
      rules: [
        {
          id: 'require-approval-wrap-action',
          name: 'Require Approval Wrap Action',
          enabled: true,
          severity: 'critical',
          action: 'require_approval',
          tools: ['transfer'],
          conditions: [
            {
              field: 'arguments.amount',
              operator: 'greater_than',
              value: 1000,
            },
          ],
        },
      ],
      logLevel: 'silent',
    });

    const wrappedTransfer = wrapAction(
      veto,
      'transfer',
      async () => 'ok'
    );

    await expect(
      wrappedTransfer({ amount: 5000 })
    ).rejects.toMatchObject({
      validationResult: expect.objectContaining({
        decision: 'require_approval',
      }),
    });
  });

  it('allows all calls when initialized with empty rules', async () => {
    const veto = Veto.fromRules({
      rules: [],
      logLevel: 'silent',
    });

    const result = await veto.guard('navigate', { url: 'https://anything.example.com' });
    expect(result.decision).toBe('allow');
  });

  it('accepts pre-parsed rule objects', async () => {
    const preParsedRules: Rule[] = [
      {
        id: 'pre-parsed-policy-rule',
        name: 'Pre Parsed Policy Rule',
        enabled: true,
        severity: 'critical',
        action: 'block',
        tools: ['click'],
        conditions: [
          {
            field: 'arguments.selector',
            operator: 'contains',
            value: 'submit',
          },
        ],
        metadata: { source: 'policy-pack-object' },
      },
    ];

    const veto = Veto.fromRules({
      rules: preParsedRules,
      logLevel: 'silent',
    });

    const result = await veto.guard('click', { selector: '#submit' });
    expect(result.decision).toBe('deny');
  });

  it('browser build entry has no node: imports', () => {
    const distPath = join(process.cwd(), 'dist/browser/index.js');
    const sourcePath = join(process.cwd(), 'src/browser/index.ts');
    const targetPath = existsSync(distPath) ? distPath : sourcePath;
    const content = readFileSync(targetPath, 'utf-8');

    expect(content).not.toContain('node:');
  });

  it('reports decisions to cloud when apiKey is provided to fromRules', async () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      apiKey: 'veto_test_key',
      endpoint: 'https://api.veto.so',
      logLevel: 'silent',
    });

    await veto.guard('navigate', { url: 'https://bank.example.com' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/decisions'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Veto-API-Key': 'veto_test_key',
        }),
      })
    );
  });

  it('browser protect fails closed by default when cloud initialization fails', async () => {
    const initError = new Error('cloud policies failed');
    const logger = { warn: vi.fn() };
    const onInitError = vi.fn();
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules');
    vi.spyOn(Veto, 'fromCloud').mockRejectedValue(initError);

    await expect(browserProtect({
      name: 'navigate',
      handler: async () => 'ok',
    }, {
      apiKey: 'veto_test_key',
      logLevel: 'silent',
      logger,
      onInitError,
    })).rejects.toBe(initError);

    expect(onInitError).toHaveBeenCalledWith(initError);
    expect(logger.warn).toHaveBeenCalledWith(
      'Veto initialization failed; failing closed and refusing to run tools unprotected',
      { error: 'cloud policies failed' }
    );
    expect(fromRulesSpy).not.toHaveBeenCalled();
  });

  it('browser protect requires explicit unsafe allow-all on cloud initialization failure', async () => {
    const initError = new Error('cloud policies failed');
    const logger = { warn: vi.fn() };
    vi.spyOn(Veto, 'fromCloud').mockRejectedValue(initError);
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules');

    const wrapped = await browserProtect({
      name: 'navigate',
      handler: async () => 'ok',
    }, {
      apiKey: 'veto_test_key',
      allowAllOnInitError: true,
      logLevel: 'silent',
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'UNSAFE Veto initialization fallback enabled; running in allow-all mode with no active policies',
      { error: 'cloud policies failed' }
    );
    expect(fromRulesSpy).toHaveBeenCalledWith(expect.objectContaining({
      rules: [],
      outputRules: [],
    }));
    expect(wrapped.name).toBe('navigate');
  });

  it('fromCloud passes mode through to the instance', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ policies: [createNavigateBlockRule()] }),
      text: async () => '',
    });

    const veto = await Veto.fromCloud({
      apiKey: 'veto_test_key',
      endpoint: 'https://api.veto.so',
      mode: 'shadow',
    });

    const result = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(result.decision).toBe('deny');
    expect(result.shadow).toBe(true);
    expect(result.shadowDecision).toBe('deny');

    veto.dispose();
  });

  it('fromCloud passes sessionId and agentId through', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ policies: [] }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
        text: async () => '',
      });

    const veto = await Veto.fromCloud({
      apiKey: 'veto_test_key',
      endpoint: 'https://api.veto.so',
      sessionId: 'sess-123',
      agentId: 'agent-x',
    });

    await veto.guard('navigate', { url: 'https://example.com' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const decisionCall = fetchMock.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/v1/decisions')
    );
    expect(decisionCall).toBeDefined();
    const body = JSON.parse((decisionCall![1] as { body: string }).body);
    expect(body.context.session_id).toBe('sess-123');
    expect(body.context.agent_id).toBe('agent-x');

    veto.dispose();
  });

  it('addRules merges local rules that evaluate correctly', async () => {
    const veto = Veto.fromRules({
      rules: [],
      logLevel: 'silent',
    });

    const result1 = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(result1.decision).toBe('allow');

    veto.addRules([createNavigateBlockRule()]);

    const result2 = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(result2.decision).toBe('deny');
    expect(result2.ruleId).toBe('block-sensitive-url');
  });

  it('addRules upserts rules by ID', async () => {
    const veto = Veto.fromRules({
      rules: [],
      logLevel: 'silent',
    });

    veto.addRules([{
      id: 'r1',
      name: 'Block admin',
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: ['navigate'],
      conditions: [{ field: 'arguments.url', operator: 'contains', value: 'admin' }],
    }]);

    const blocked = await veto.guard('navigate', { url: 'https://admin.example.com' });
    expect(blocked.decision).toBe('deny');

    veto.addRules([{
      id: 'r1',
      name: 'Block admin (updated)',
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: ['navigate'],
      conditions: [{ field: 'arguments.url', operator: 'contains', value: 'superadmin' }],
    }]);

    const allowed = await veto.guard('navigate', { url: 'https://admin.example.com' });
    expect(allowed.decision).toBe('allow');

    const stillBlocked = await veto.guard('navigate', { url: 'https://superadmin.example.com' });
    expect(stillBlocked.decision).toBe('deny');
  });

  it('removeRule removes a locally-added rule', async () => {
    const veto = Veto.fromRules({
      rules: [],
      logLevel: 'silent',
    });

    veto.addRules([createNavigateBlockRule()]);
    const blocked = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(blocked.decision).toBe('deny');

    veto.removeRule('block-sensitive-url');
    const allowed = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(allowed.decision).toBe('allow');
  });

  it('getRules returns all indexed rules', () => {
    const veto = Veto.fromRules({
      rules: [createNavigateBlockRule()],
      logLevel: 'silent',
    });

    veto.addRules([{
      id: 'local-1',
      name: 'Local Rule',
      enabled: true,
      severity: 'low',
      action: 'log',
    }]);

    const all = veto.getRules();
    expect(all).toHaveLength(2);
    expect(all.map(r => r.id)).toContain('block-sensitive-url');
    expect(all.map(r => r.id)).toContain('local-1');
  });

  it('local rules survive refreshRules', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ policies: [] }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ policies: [] }),
        text: async () => '',
      });

    const veto = await Veto.fromCloud({
      apiKey: 'veto_test_key',
      endpoint: 'https://api.veto.so',
    });

    veto.addRules([createNavigateBlockRule()]);
    const blocked = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(blocked.decision).toBe('deny');

    await veto.refreshRules();

    const stillBlocked = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(stillBlocked.decision).toBe('deny');

    veto.dispose();
  });

  it('local rules take precedence over cloud rules', async () => {
    const veto = Veto.fromRules({
      rules: [{
        id: 'cloud-allow-all',
        name: 'Allow All Navigation',
        enabled: true,
        severity: 'low',
        action: 'allow',
        tools: ['navigate'],
      }],
      logLevel: 'silent',
    });

    veto.addRules([createNavigateBlockRule()]);

    const result = await veto.guard('navigate', { url: 'https://bank.example.com' });
    expect(result.decision).toBe('deny');
  });
});
