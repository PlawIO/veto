import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protect, __resetProtectCacheForTests } from '../../src/core/protect.js';
import { ToolCallDeniedError } from '../../src/core/veto.js';

interface TestTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createTool(name: string, response: unknown = 'ok'): TestTool {
  return {
    name,
    handler: vi.fn(async () => response),
  };
}

describe('protect auto-apply policy packs', () => {
  let previousCwd = process.cwd();
  let testDir = '';

  beforeEach(() => {
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
    previousCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'veto-auto-apply-'));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(testDir, { recursive: true, force: true });
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
  });

  it('auto-applies financial pack for transfer_funds', async () => {
    const wrapped = await protect([createTool('transfer_funds')], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ amount: 15000, currency: 'USD' })).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('auto-applies browser pack for navigate', async () => {
    const wrapped = await protect([createTool('navigate')], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ url: 'javascript:alert(1)' })).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('auto-applies communication pack for send_email', async () => {
    const wrapped = await protect([createTool('send_email')], { logLevel: 'silent' });

    await expect(
      wrapped[0].handler({
        to: ['a@acme.com', 'b@acme.com', 'c@acme.com', 'd@acme.com', 'e@acme.com', 'f@acme.com'],
        subject: 'status',
        body: 'hello',
      })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('auto-applies deployment pack for deploy', async () => {
    const wrapped = await protect([createTool('deploy')], { logLevel: 'silent' });

    await expect(
      wrapped[0].handler({
        environment: 'production',
      })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('merges multiple packs when mixed tools are provided', async () => {
    const wrapped = await protect(
      [createTool('transfer_funds'), createTool('send_email'), createTool('deploy')],
      { logLevel: 'silent' }
    );

    await expect(wrapped[0].handler({ amount: 15000, currency: 'USD' })).rejects.toBeInstanceOf(ToolCallDeniedError);
    await expect(wrapped[1].handler({ to: ['x@acme.com'], body: 'password: hunter2' })).rejects.toBeInstanceOf(ToolCallDeniedError);
    await expect(wrapped[2].handler({ force: true, environment: 'staging' })).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('falls back to allow-all when no heuristics match', async () => {
    const wrapped = await protect([createTool('unknown_tool', 'allowed')], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ any: true })).resolves.toBe('allowed');
  });

  it('blocks credential-like content in communication pack', async () => {
    const wrapped = await protect([createTool('send_email')], { logLevel: 'silent' });

    await expect(
      wrapped[0].handler({
        to: ['a@acme.com'],
        subject: 'credentials',
        body: 'api_key = sk_live_123',
      })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('requires approval for more than five recipients', async () => {
    const wrapped = await protect([createTool('send_email')], { logLevel: 'silent' });

    await expect(
      wrapped[0].handler({
        to: ['a@acme.com', 'b@acme.com', 'c@acme.com', 'd@acme.com', 'e@acme.com', 'f@acme.com'],
        subject: 'team update',
        body: 'status',
      })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('requires approval for production deploys', async () => {
    const wrapped = await protect([createTool('deploy')], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ env: 'prod' })).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('blocks force deployments', async () => {
    const wrapped = await protect([createTool('deploy')], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ force: true, environment: 'staging' })).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('requires approval for high-value financial transfers and allows lower values', async () => {
    const wrapped = await protect([createTool('transfer_funds', 'executed')], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ amount: 15000, currency: 'USD' })).rejects.toBeInstanceOf(ToolCallDeniedError);
    await expect(wrapped[0].handler({ amount: 5000, currency: 'USD' })).resolves.toBe('executed');
  });

  it('prints stderr message when packs are auto-applied', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await protect([createTool('transfer_funds'), createTool('send_email')], { logLevel: 'info' });

    const output = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('[veto] Auto-applied policy packs: @veto/communication, @veto/financial');
    expect(output).toContain("Run 'npx veto test' for details.");
  });

  it('does not print stderr message when logLevel is silent', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await protect([createTool('transfer_funds')], { logLevel: 'silent' });

    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
