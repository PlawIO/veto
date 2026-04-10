import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    init: vi.fn(),
    createBefore: vi.fn(),
    createAfter: vi.fn(),
    definePluginEntry: vi.fn((entry) => entry),
  };
});

vi.mock('veto-sdk', () => ({
  Veto: {
    init: mocks.init,
  },
}));

vi.mock('veto-sdk/integrations/openclaw', () => ({
  createVetoBeforeToolCallHook: mocks.createBefore,
  createVetoAfterToolCallHook: mocks.createAfter,
}));

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: mocks.definePluginEntry,
}));

describe('openclaw-veto plugin', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.init.mockReset();
    mocks.createBefore.mockReset();
    mocks.createAfter.mockReset();
    mocks.definePluginEntry.mockClear();
    mocks.definePluginEntry.mockImplementation((entry) => entry);
    mocks.createBefore.mockReturnValue(async () => undefined);
    mocks.createAfter.mockReturnValue(async () => undefined);
  });

  it('fails fast when veto-cloud approval mode is configured without cloud readiness', async () => {
    mocks.init.mockResolvedValue({
      isCloudReady: () => false,
      getRuntimeInfo: () => ({ validationMode: 'local', cloudReady: false }),
    });

    const plugin = (await import('./index.js')).default;
    const api = {
      registerHook: vi.fn(),
      getConfig: () => ({ approvalMode: 'veto-cloud' }),
      log: vi.fn(),
    };

    await expect(plugin.register(api)).rejects.toThrow(
      '[veto] approvalMode "veto-cloud" requires Veto Cloud mode. Configure VETO_API_KEY or cloud.apiKey in veto/veto.config.yaml, or switch approvalMode to "openclaw-native".',
    );

    expect(api.registerHook).not.toHaveBeenCalled();
    expect(mocks.createBefore).not.toHaveBeenCalled();
    expect(mocks.createAfter).not.toHaveBeenCalled();
  });

  it('registers hooks and logs startup diagnostics when veto-cloud is ready', async () => {
    const beforeHook = async (): Promise<void> => undefined;
    const afterHook = async (): Promise<void> => undefined;

    mocks.createBefore.mockReturnValue(beforeHook);
    mocks.createAfter.mockReturnValue(afterHook);
    mocks.init.mockResolvedValue({
      isCloudReady: () => true,
      getRuntimeInfo: () => ({ validationMode: 'cloud', cloudReady: true }),
    });

    const plugin = (await import('./index.js')).default;
    const api = {
      registerHook: vi.fn(),
      getConfig: () => ({ approvalMode: 'veto-cloud' }),
      log: vi.fn(),
    };

    await plugin.register(api);

    expect(mocks.createBefore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approvalMode: 'veto-cloud' }),
    );
    expect(mocks.createAfter).toHaveBeenCalledWith(expect.anything());
    expect(api.registerHook).toHaveBeenCalledWith('before_tool_call', beforeHook);
    expect(api.registerHook).toHaveBeenCalledWith('after_tool_call', afterHook);
    expect(api.log).toHaveBeenCalledWith(
      'info',
      '[veto] Plugin loaded (approval mode: veto-cloud, validation mode: cloud)',
    );
  });
});
