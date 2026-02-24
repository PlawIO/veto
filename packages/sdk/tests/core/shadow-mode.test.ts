import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Veto } from '../../src/core/veto.js';
import type { Rule } from '../../src/rules/types.js';

const blockRule: Rule = {
  id: 'shadow-block',
  name: 'Shadow Block',
  enabled: true,
  severity: 'high',
  action: 'block',
  tools: ['transfer_funds'],
  conditions: [
    {
      field: 'arguments.amount',
      operator: 'greater_than',
      value: 1000,
    },
  ],
};

const approvalRule: Rule = {
  id: 'shadow-approval',
  name: 'Shadow Approval',
  enabled: true,
  severity: 'critical',
  action: 'require_approval',
  tools: ['deploy'],
  conditions: [
    {
      field: 'arguments.env',
      operator: 'equals',
      value: 'prod',
    },
  ],
};

function flushAsyncTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('shadow mode', () => {
  const originalMode = process.env.VETO_MODE;
  const originalFetch = global.fetch;

  beforeEach(() => {
    delete process.env.VETO_MODE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.VETO_MODE;
    } else {
      process.env.VETO_MODE = originalMode;
    }
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('allows wrapped calls while preserving real deny decision metadata', async () => {
    const handler = vi.fn(async () => 'executed');
    const veto = Veto.fromRules({
      rules: [blockRule],
      mode: 'shadow',
      logLevel: 'silent',
    });

    const validation = await veto.validateToolCall({
      name: 'transfer_funds',
      arguments: { amount: 5000 },
    });
    expect(validation.allowed).toBe(true);
    expect(validation.validationResult.decision).toBe('deny');
    expect(validation.validationResult.metadata).toMatchObject({
      shadow: true,
      shadow_decision: 'deny',
      shadow_rule_id: 'shadow-block',
    });

    const wrapped = veto.wrap([{ name: 'transfer_funds', handler, inputSchema: {} }]);
    await expect(wrapped[0].handler({ amount: 5000 })).resolves.toBe('executed');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows wrapped calls for require_approval while preserving real decision', async () => {
    const handler = vi.fn(async () => 'deployed');
    const veto = Veto.fromRules({
      rules: [approvalRule],
      mode: 'shadow',
      logLevel: 'silent',
    });

    const validation = await veto.validateToolCall({
      name: 'deploy',
      arguments: { env: 'prod' },
    });
    expect(validation.allowed).toBe(true);
    expect(validation.validationResult.decision).toBe('require_approval');
    expect(validation.validationResult.metadata).toMatchObject({
      shadow: true,
      shadow_decision: 'require_approval',
      shadow_rule_id: 'shadow-approval',
    });

    const wrapped = veto.wrap([{ name: 'deploy', handler, inputSchema: {} }]);
    await expect(wrapped[0].handler({ env: 'prod' })).resolves.toBe('deployed');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('guard returns real deny decision with shadow markers', async () => {
    const veto = Veto.fromRules({
      rules: [blockRule],
      mode: 'shadow',
      logLevel: 'silent',
    });

    const result = await veto.guard('transfer_funds', { amount: 5000 });
    expect(result.decision).toBe('deny');
    expect(result.shadow).toBe(true);
    expect(result.shadowDecision).toBe('deny');
  });

  it('writes formatted stderr output for shadow denials', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const veto = Veto.fromRules({
      rules: [blockRule],
      mode: 'shadow',
      logLevel: 'info',
    });

    await veto.validateToolCall({
      name: 'transfer_funds',
      arguments: { amount: 5000 },
    });

    expect(stderrSpy).toHaveBeenCalled();
    const output = String(stderrSpy.mock.calls[0]?.[0] ?? '');
    expect(output).toContain('[shadow]');
    expect(output).toContain('WOULD BE DENIED');
    expect(output).toContain('transfer_funds(');
  });

  it('suppresses shadow stderr output when log level is silent', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const veto = Veto.fromRules({
      rules: [blockRule],
      mode: 'shadow',
      logLevel: 'silent',
    });

    await veto.validateToolCall({
      name: 'transfer_funds',
      arguments: { amount: 5000 },
    });

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits decision events with shadow=true', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      text: async () => '',
    }));
    global.fetch = fetchMock as typeof fetch;

    const veto = Veto.fromRules({
      rules: [blockRule],
      mode: 'shadow',
      logLevel: 'silent',
      events: {
        webhook: {
          url: 'https://hooks.example.com/veto',
          on: ['deny'],
          min_severity: 'info',
          format: 'generic',
        },
      },
    });

    const guardResult = await veto.guard('transfer_funds', { amount: 5000 });
    expect(guardResult.decision).toBe('deny');

    await flushAsyncTasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(payload.event_type).toBe('deny');
    expect(payload.shadow).toBe(true);
  });

  it('adds shadow markers to browser-mode decision log context', async () => {
    const logDecision = vi.fn();
    const veto = Veto.fromRules({
      rules: [blockRule],
      mode: 'shadow',
      logLevel: 'silent',
      cloudClient: {
        fetchPolicies: async () => ({ policies: [] }),
        logDecision,
      },
    });

    await veto.guard('transfer_funds', { amount: 5000 });

    expect(logDecision).toHaveBeenCalledTimes(1);
    const request = logDecision.mock.calls[0]?.[0] as {
      context?: Record<string, unknown>;
    };
    expect(request.context?.shadow).toBe(true);
    expect(request.context?.shadow_decision).toBe('deny');
  });

  it('uses VETO_MODE=shadow when mode is omitted', async () => {
    process.env.VETO_MODE = 'shadow';
    const veto = Veto.fromRules({
      rules: [blockRule],
      logLevel: 'silent',
    });

    const result = await veto.guard('transfer_funds', { amount: 5000 });
    expect(result.shadow).toBe(true);
    expect(result.shadowDecision).toBe('deny');
  });
});
