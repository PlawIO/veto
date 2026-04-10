import { describe, expect, it, vi } from 'vitest';
import { ApprovalTimeoutError } from '../../src/cloud/client.js';
import {
  createVetoAfterToolCallHook,
  createVetoBeforeToolCallHook,
} from '../../src/integrations/openclaw/index.js';

describe('OpenClaw integration', () => {
  it('allows tool calls when veto allows them', async () => {
    const onAllow = vi.fn();
    const veto = {
      guard: vi.fn().mockResolvedValue({ decision: 'allow' }),
    } as any;

    const hook = createVetoBeforeToolCallHook(veto, { onAllow });
    const result = await hook({ toolName: 'search', toolArgs: { query: 'hello' } });

    expect(result).toBeUndefined();
    expect(veto.guard).toHaveBeenCalledWith('search', { query: 'hello' }, {
      sessionId: undefined,
      agentId: undefined,
    });
    expect(onAllow).toHaveBeenCalledWith('search', { query: 'hello' });
  });

  it('blocks denied tool calls', async () => {
    const onDeny = vi.fn();
    const veto = {
      guard: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'Not allowed' }),
    } as any;

    const hook = createVetoBeforeToolCallHook(veto, { onDeny });
    const result = await hook({ toolName: 'delete_file', toolArgs: { path: '/tmp/x' } });

    expect(result).toEqual({ block: true, message: 'Not allowed' });
    expect(onDeny).toHaveBeenCalledWith('delete_file', { path: '/tmp/x' }, 'Not allowed');
  });

  it('returns requireApproval in openclaw-native mode', async () => {
    const onApprovalRequired = vi.fn();
    const veto = {
      guard: vi.fn().mockResolvedValue({
        decision: 'require_approval',
        reason: 'Need approval',
        approvalId: 'appr_123',
      }),
    } as any;

    const hook = createVetoBeforeToolCallHook(veto, { onApprovalRequired });
    const result = await hook({ toolName: 'bash', toolArgs: { command: 'rm -rf /tmp' } });

    expect(result).toEqual({ requireApproval: true, message: 'Need approval' });
    expect(onApprovalRequired).toHaveBeenCalledWith(
      'bash',
      { command: 'rm -rf /tmp' },
      'appr_123',
    );
  });

  it('waits for approval in veto-cloud mode and allows approved calls', async () => {
    const onApprovalRequired = vi.fn();
    const veto = {
      guard: vi.fn().mockResolvedValue({
        decision: 'require_approval',
        reason: 'Need approval',
        approvalId: 'appr_456',
      }),
      waitForApproval: vi.fn().mockResolvedValue({ status: 'approved', resolvedBy: 'alice' }),
    } as any;

    const hook = createVetoBeforeToolCallHook(veto, {
      approvalMode: 'veto-cloud',
      onApprovalRequired,
    });
    const result = await hook({ toolName: 'deploy', toolArgs: { env: 'prod' } });

    expect(result).toBeUndefined();
    expect(veto.waitForApproval).toHaveBeenCalledWith('appr_456');
    expect(onApprovalRequired).toHaveBeenCalledWith('deploy', { env: 'prod' }, 'appr_456');
  });

  it('blocks expired cloud approvals', async () => {
    const onDeny = vi.fn();
    const veto = {
      guard: vi.fn().mockResolvedValue({
        decision: 'require_approval',
        reason: 'Need approval',
        approvalId: 'appr_789',
      }),
      waitForApproval: vi.fn().mockRejectedValue(new ApprovalTimeoutError('appr_789', 1000)),
    } as any;

    const hook = createVetoBeforeToolCallHook(veto, {
      approvalMode: 'veto-cloud',
      onDeny,
    });
    const result = await hook({ toolName: 'deploy', toolArgs: { env: 'prod' } });

    expect(result).toEqual({ block: true, message: 'Approval expired' });
    expect(onDeny).toHaveBeenCalledWith('deploy', { env: 'prod' }, 'Approval expired');
  });

  it('logs execution through veto.logToolExecution when available', async () => {
    const veto = {
      logToolExecution: vi.fn(),
    } as any;

    const hook = createVetoAfterToolCallHook(veto, { sessionId: 'sess_1', agentId: 'agent_1' });
    await hook({ toolName: 'search', toolArgs: { query: 'hello' }, result: { ok: true } });

    expect(veto.logToolExecution).toHaveBeenCalledWith(
      'search',
      { query: 'hello' },
      { ok: true },
      expect.objectContaining({
        sessionId: 'sess_1',
        agentId: 'agent_1',
      }),
    );
  });

  it('falls back to historyTracker when execution logger is unavailable', async () => {
    const record = vi.fn();
    const veto = {
      historyTracker: { record },
    } as any;

    const hook = createVetoAfterToolCallHook(veto);
    await hook({
      toolName: 'search',
      toolArgs: { query: 'hello' },
      error: new Error('boom'),
    });

    expect(record).toHaveBeenCalledWith(
      'search',
      { query: 'hello' },
      expect.objectContaining({
        decision: 'allow',
        reason: 'Tool execution failed',
      }),
    );
  });
});
