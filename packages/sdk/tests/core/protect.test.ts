import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protect, __resetProtectCacheForTests } from '../../src/core/protect.js';
import { ToolCallDeniedError, Veto } from '../../src/core/veto.js';
import type { Rule } from '../../src/rules/types.js';

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

function createAmountBlockRule(toolName: string): Rule {
  return {
    id: `block-${toolName}`,
    name: `Block ${toolName}`,
    enabled: true,
    severity: 'high',
    action: 'block',
    tools: [toolName],
    conditions: [
      {
        field: 'arguments.amount',
        operator: 'greater_than',
        value: 1000,
      },
    ],
  };
}

describe('protect', () => {
  let previousCwd = process.cwd();
  let testDir = '';

  beforeEach(() => {
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
    previousCwd = process.cwd();
    testDir = mkdtempSync(join(tmpdir(), 'veto-protect-'));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(testDir, { recursive: true, force: true });
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
  });

  it('wraps tool arrays and preserves array shape', async () => {
    const tools = [createTool('tool_a', 'a'), createTool('tool_b', 'b')];

    const wrapped = await protect(tools, { rules: [], logLevel: 'silent' });

    expect(Array.isArray(wrapped)).toBe(true);
    expect(wrapped).toHaveLength(2);
    await expect(wrapped[0].handler({})).resolves.toBe('a');
    await expect(wrapped[1].handler({})).resolves.toBe('b');
  });

  it('wraps a single tool and returns a single tool', async () => {
    const tool = createTool('single_tool', 'single');

    const wrapped = await protect(tool, { rules: [], logLevel: 'silent' });

    expect(Array.isArray(wrapped)).toBe(false);
    await expect(wrapped.handler({})).resolves.toBe('single');
  });

  it('uses pack option to apply built-in pack rules', async () => {
    const tool = createTool('transfer_funds');

    const wrapped = await protect([tool], {
      pack: 'financial',
      mode: 'strict',
      logLevel: 'silent',
    });

    await expect(
      wrapped[0].handler({ amount: 15000, currency: 'USD' })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('prefers explicit pack selection over an ambient local veto directory', async () => {
    mkdirSync(join(testDir, 'veto'), { recursive: true });
    const tool = createTool('transfer_funds');

    const wrapped = await protect([tool], {
      pack: 'financial',
      mode: 'strict',
      logLevel: 'silent',
    });

    await expect(
      wrapped[0].handler({ amount: 15000, currency: 'USD' })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('uses apiKey path to initialize cloud mode', async () => {
    const tool = createTool('cloud_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const initSpy = vi.spyOn(Veto, 'init').mockResolvedValue(fakeVeto);

    await protect([tool], { apiKey: 'veto_xxx', logLevel: 'silent' });

    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'veto_xxx',
    }));
  });

  it('fails closed by default when initialization fails', async () => {
    const tool = createTool('cloud_tool');
    const initError = new Error('cloud init failed');
    const logger = { warn: vi.fn() };
    const onInitError = vi.fn();
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules');
    vi.spyOn(Veto, 'init').mockRejectedValue(initError);

    await expect(protect([tool], {
      apiKey: 'veto_xxx',
      logLevel: 'silent',
      logger,
      onInitError,
    })).rejects.toBe(initError);

    expect(onInitError).toHaveBeenCalledWith(initError);
    expect(logger.warn).toHaveBeenCalledWith(
      'Veto initialization failed; failing closed and refusing to run tools unprotected',
      { error: 'cloud init failed' }
    );
    expect(fromRulesSpy).not.toHaveBeenCalled();
  });

  it('requires an explicit unsafe option to allow-all after initialization failure', async () => {
    const tool = createTool('cloud_tool', 'allowed');
    const initError = new Error('cloud init failed');
    const logger = { warn: vi.fn() };
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;
    vi.spyOn(Veto, 'init').mockRejectedValue(initError);
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    const wrapped = await protect([tool], {
      apiKey: 'veto_xxx',
      allowAllOnInitError: true,
      logLevel: 'silent',
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'UNSAFE Veto initialization fallback enabled; running in allow-all mode with no active policies',
      { error: 'cloud init failed' }
    );
    expect(fromRulesSpy).toHaveBeenCalledWith(expect.objectContaining({
      rules: [],
      outputRules: [],
    }));
    await expect(wrapped[0].handler({})).resolves.toBe('allowed');
  });

  it('uses fromRules path when inline rules are provided', async () => {
    const tool = createTool('transfer_funds');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], {
      rules: [createAmountBlockRule('transfer_funds')],
      logLevel: 'silent',
    });

    expect(fromRulesSpy).toHaveBeenCalledTimes(1);
  });

  it('maps stream options to decision stream logger settings for inline rules', async () => {
    const tool = createTool('stream_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], {
      rules: [],
      stream: true,
      streamMode: 'verbose',
      logLevel: 'silent',
    });

    expect(fromRulesSpy).toHaveBeenCalledWith(expect.objectContaining({
      logLevel: 'stream',
      stream: true,
      streamMode: 'verbose',
    }));
  });

  it('passes decision stream settings through the init path', async () => {
    const tool = createTool('cloud_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const initSpy = vi.spyOn(Veto, 'init').mockResolvedValue(fakeVeto);

    await protect([tool], {
      apiKey: 'veto_xxx',
      stream: true,
      streamMode: 'verbose',
      logLevel: 'silent',
    });

    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'veto_xxx',
      logLevel: 'stream',
      streamMode: 'verbose',
    }));
  });

  it('applies log mode (allows while logging)', async () => {
    const tool = createTool('transfer_funds', 'executed');

    const wrapped = await protect([tool], {
      rules: [createAmountBlockRule('transfer_funds')],
      mode: 'log',
      logLevel: 'silent',
    });

    await expect(wrapped[0].handler({ amount: 2000 })).resolves.toBe('executed');
  });

  it('passes shadow mode through to Veto without aliasing', async () => {
    const tool = createTool('transfer_funds');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], {
      rules: [],
      mode: 'shadow',
      logLevel: 'silent',
    });

    expect(fromRulesSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'shadow',
    }));
  });

  it('auto-detects financial pack for transfer_funds', async () => {
    const tool = createTool('transfer_funds');

    const wrapped = await protect([tool], { logLevel: 'silent' });

    await expect(
      wrapped[0].handler({ amount: 15000, currency: 'USD' })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('auto-detects browser pack for navigate', async () => {
    const tool = createTool('navigate');

    const wrapped = await protect([tool], { logLevel: 'silent' });

    await expect(
      wrapped[0].handler({ url: 'javascript:alert(1)' })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('uses safe defaults in log mode when no heuristics match', async () => {
    const tool = createTool('non_matching_tool', 'allowed');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], { logLevel: 'silent' });

    expect(fromRulesSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'log',
      rules: expect.arrayContaining([
        expect.objectContaining({ id: 'safe-defaults-warn-destructive-shell', action: 'warn' }),
      ]),
    }));
  });

  it('allows unknown tools under safe-defaults observe mode', async () => {
    const tool = createTool('non_matching_tool', 'allowed');

    const wrapped = await protect([tool], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ any: 'value' })).resolves.toBe('allowed');
  });

  it('falls through when local policy discovery hits broken filesystem entries', async () => {
    mkdirSync(join(testDir, 'veto', 'rules'), { recursive: true });
    symlinkSync(join(testDir, 'missing-rules-dir'), join(testDir, 'veto', 'rules', 'broken-link'));
    const tool = createTool('non_matching_tool', 'allowed');

    const wrapped = await protect([tool], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ any: 'value' })).resolves.toBe('allowed');
  });

  it('re-evaluates heuristics on repeated no-options calls instead of reusing allow-all state', async () => {
    const passthroughTool = createTool('non_matching_tool', 'allowed');
    const transferTool = createTool('transfer_funds');

    const firstWrapped = await protect([passthroughTool]);
    await expect(firstWrapped[0].handler({ any: 'value' })).resolves.toBe('allowed');

    const secondWrapped = await protect([transferTool]);
    await expect(
      secondWrapped[0].handler({ amount: 15000, currency: 'USD' })
    ).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('reuses cached Veto instance for identical options', async () => {
    const tool = createTool('cached_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], { rules: [], logLevel: 'silent' });
    await protect([tool], { rules: [], logLevel: 'silent' });

    expect(fromRulesSpy).toHaveBeenCalledTimes(1);
  });

  it('creates a new Veto instance when decision stream settings differ', async () => {
    const tool = createTool('cached_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], { rules: [], logLevel: 'silent' });
    await protect([tool], { rules: [], stream: true, streamMode: 'verbose', logLevel: 'silent' });

    expect(fromRulesSpy).toHaveBeenCalledTimes(2);
  });

  it('creates a new Veto instance when mode changes', async () => {
    const tool = createTool('cached_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], { rules: [], logLevel: 'silent' });
    await protect([tool], { rules: [], mode: 'log', logLevel: 'silent' });

    expect(fromRulesSpy).toHaveBeenCalledTimes(2);
  });

  it('creates a new Veto instance when the approval callback changes', async () => {
    const tool = createTool('cached_tool');
    const fakeVeto = {
      wrap: vi.fn((tools: TestTool[]) => tools),
      wrapTool: vi.fn((singleTool: TestTool) => singleTool),
    } as unknown as Veto;

    const fromRulesSpy = vi.spyOn(Veto, 'fromRules').mockReturnValue(fakeVeto);

    await protect([tool], {
      rules: [],
      logLevel: 'silent',
      onApprovalRequired: vi.fn(),
    });
    await protect([tool], {
      rules: [],
      logLevel: 'silent',
      onApprovalRequired: vi.fn(),
    });

    expect(fromRulesSpy).toHaveBeenCalledTimes(2);
  });

  it('validates before execution and throws ToolCallDeniedError on deny', async () => {
    const tool = createTool('transfer_funds', 'should-not-run');

    const wrapped = await protect([tool], {
      rules: [createAmountBlockRule('transfer_funds')],
      mode: 'strict',
      logLevel: 'silent',
    });

    await expect(wrapped[0].handler({ amount: 5000 })).rejects.toBeInstanceOf(ToolCallDeniedError);
    expect(tool.handler).not.toHaveBeenCalled();
  });
});
