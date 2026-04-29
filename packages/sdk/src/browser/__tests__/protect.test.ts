import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protect, __resetProtectCacheForTests } from '../protect.js';
import { ToolCallDeniedError } from '../../core/interceptor.js';
import { Veto } from '../veto.js';

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

describe('browser protect', () => {
  beforeEach(() => {
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    __resetProtectCacheForTests();
    vi.restoreAllMocks();
  });

  it('uses inline rules when provided', async () => {
    const tool = createTool('navigate');

    const wrapped = await protect([tool], {
      rules: [
        {
          id: 'block-nav',
          name: 'Block Navigate',
          enabled: true,
          severity: 'high',
          action: 'block',
          tools: ['navigate'],
          conditions: [
            {
              field: 'arguments.url',
              operator: 'contains',
              value: 'blocked',
            },
          ],
        },
      ],
      logLevel: 'silent',
    });

    await expect(wrapped[0].handler({ url: 'https://blocked.example.com' })).rejects.toBeInstanceOf(ToolCallDeniedError);
  });

  it('falls back to allow-all when no explicit source is provided', async () => {
    const tool = createTool('unknown_tool', 'allowed');

    const wrapped = await protect([tool], { logLevel: 'silent' });

    await expect(wrapped[0].handler({ anything: true })).resolves.toBe('allowed');
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

  it('reuses cached instances for identical options', async () => {
    const tool = createTool('cached_tool');
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules');

    await protect([tool], { rules: [], logLevel: 'silent' });
    await protect([tool], { rules: [], logLevel: 'silent' });

    expect(fromRulesSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses allow-all browser instances across different tool names when options are otherwise identical', async () => {
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules');

    await protect([createTool('navigate')], { logLevel: 'silent' });
    await protect([createTool('transfer_funds')], { logLevel: 'silent' });

    expect(fromRulesSpy).toHaveBeenCalledTimes(1);
  });

  it('creates a new instance when the approval callback changes', async () => {
    const tool = createTool('cached_tool');
    const fromRulesSpy = vi.spyOn(Veto, 'fromRules');

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
});
