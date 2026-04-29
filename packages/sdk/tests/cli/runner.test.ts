import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('cli agent compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/cli/agent.js');
  });

  it('prints agent help without deprecated label or warning', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['agent'])).resolves.toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Agent commands:');
    expect(logSpy).not.toHaveBeenCalledWith('Agent commands (deprecated):');
  });

  it('dispatches compatibility subcommands without deprecation warning', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const agentPolicyList = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../src/cli/agent.js', () => ({
      agentConfig: vi.fn(),
      agentInit: vi.fn(),
      agentPolicyAdd: vi.fn(),
      agentPolicyList,
      agentScan: vi.fn(),
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['agent', 'policy', 'list'])).resolves.toBe(0);
    expect(agentPolicyList).toHaveBeenCalledWith({
      directory: undefined,
      format: undefined,
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('passes --directory through to init', async () => {
    const initMock = vi.fn().mockResolvedValue({ success: true });

    vi.doMock('../../src/cli/init.js', () => ({
      init: initMock,
    }));

    const { runCli } = await import('../../src/cli/runner.js');

    await expect(runCli(['init', '--directory', '/tmp/veto-cli-target', '--quiet'])).resolves.toBe(0);
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/veto-cli-target',
      quiet: true,
    }));
  });
});
