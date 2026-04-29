import { afterEach, describe, expect, it, vi } from 'vitest';

function createMockBrowserUseModule() {
  class GoToUrlParams {
    get url(): string {
      return '';
    }
  }

  class ClickElementParams {
    get selector(): string {
      return '';
    }
  }

  class Controller {
    registry: {
      actions: Map<string, { name: string; description: string; paramModel?: { prototype: object } }>;
    };
    baseActCalls: Array<{ actionName: string; params: Record<string, unknown>; browserContext: unknown }>;

    constructor() {
      this.baseActCalls = [];
      this.registry = {
        actions: new Map([
          ['go_to_url', {
            name: 'go_to_url',
            description: 'Navigate to a URL',
            paramModel: GoToUrlParams,
          }],
          ['click_element', {
            name: 'click_element',
            description: 'Click a page element',
            paramModel: ClickElementParams,
          }],
        ]),
      };
    }

    async act(action: { constructor: { getName: () => string } }, browserContext: unknown) {
      const actionName = action.constructor.getName();
      const params = { ...(action as Record<string, unknown>) };
      this.baseActCalls.push({ actionName, params, browserContext });
      return { source: 'super', actionName, params, browserContext };
    }
  }

  class ActionResult {
    error?: string;

    constructor(init?: { error?: string }) {
      this.error = init?.error;
    }
  }

  class GoToUrlAction {
    url: string;

    constructor(url: string) {
      this.url = url;
    }

    static getName(): string {
      return 'go_to_url';
    }
  }

  class ClickElementAction {
    selector: string;

    constructor(selector: string) {
      this.selector = selector;
    }

    static getName(): string {
      return 'click_element';
    }
  }

  class RawAction {
    note: string;

    constructor(note: string) {
      this.note = note;
    }

    static getName(): string {
      return 'raw_unvalidated';
    }
  }

  return {
    Controller,
    ActionResult,
    GoToUrlAction,
    ClickElementAction,
    RawAction,
  };
}

describe('browser-use integration', () => {
  afterEach(() => {
    vi.doUnmock('browser-use-node');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('throws a helpful error when browser-use-node is not installed', async () => {
    vi.doMock('browser-use-node', () => {
      throw new Error('Cannot find package browser-use-node');
    });

    const { wrapBrowserUse } = await import('../../src/integrations/browser-use/index.js');

    await expect(wrapBrowserUse({} as any)).rejects.toThrow(
      /browser-use-node is required for this integration/
    );
  });

  it('registers browser actions and validates allowed actions before execution', async () => {
    const browserUse = createMockBrowserUseModule();
    vi.doMock('browser-use-node', () => browserUse);

    const { wrapBrowserUse } = await import('../../src/integrations/browser-use/index.js');
    const validatedHandler = vi.fn().mockResolvedValue(undefined);
    const veto = {
      wrap: vi.fn((tools: Array<{ name: string }>) => tools.map((tool) => ({
        ...tool,
        handler: tool.name === 'go_to_url'
          ? validatedHandler
          : vi.fn().mockResolvedValue(undefined),
      }))),
      registerTools: vi.fn().mockResolvedValue(undefined),
    } as any;
    const onAllow = vi.fn();

    const controller = await wrapBrowserUse(veto, {
      validatedActions: new Set(['go_to_url']),
      onAllow,
    });

    const result = await controller.act(
      new browserUse.GoToUrlAction('https://example.com'),
      { tabId: 7 },
    );

    expect(validatedHandler).toHaveBeenCalledWith({ url: 'https://example.com' });
    expect(onAllow).toHaveBeenCalledWith('go_to_url', { url: 'https://example.com' });
    expect(result).toEqual({
      source: 'super',
      actionName: 'go_to_url',
      params: { url: 'https://example.com' },
      browserContext: { tabId: 7 },
    });
    expect(controller.baseActCalls).toHaveLength(1);
    expect(veto.registerTools).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'go_to_url',
          description: 'Navigate to a URL',
          parameters: [
            { name: 'url', type: 'string', description: undefined },
          ],
        }),
      ]),
    );
  });

  it('returns an ActionResult when Veto denies a browser action', async () => {
    const browserUse = createMockBrowserUseModule();
    vi.doMock('browser-use-node', () => browserUse);

    const { wrapBrowserUse } = await import('../../src/integrations/browser-use/index.js');
    const { ToolCallDeniedError } = await import('../../src/core/veto.js');
    const deniedHandler = vi.fn().mockRejectedValue(
      new ToolCallDeniedError(
        'click_element',
        'call_1',
        { decision: 'deny', reason: 'Dangerous selector' } as any,
      ),
    );
    const veto = {
      wrap: vi.fn((tools: Array<{ name: string }>) => tools.map((tool) => ({
        ...tool,
        handler: tool.name === 'click_element'
          ? deniedHandler
          : vi.fn().mockResolvedValue(undefined),
      }))),
      registerTools: vi.fn().mockResolvedValue(undefined),
    } as any;
    const onDeny = vi.fn();

    const controller = await wrapBrowserUse(veto, {
      validatedActions: new Set(['click_element']),
      onDeny,
    });

    const result = await controller.act(
      new browserUse.ClickElementAction('#delete-account'),
      { tabId: 3 },
    );

    expect(deniedHandler).toHaveBeenCalledWith({ selector: '#delete-account' });
    expect(onDeny).toHaveBeenCalledWith(
      'click_element',
      { selector: '#delete-account' },
      'Dangerous selector',
    );
    expect(result).toBeInstanceOf(browserUse.ActionResult);
    expect(result.error).toBe('Action blocked by Veto: Dangerous selector');
    expect(controller.baseActCalls).toHaveLength(0);
  });

  it('passes through actions outside the validated set', async () => {
    const browserUse = createMockBrowserUseModule();
    vi.doMock('browser-use-node', () => browserUse);

    const { wrapBrowserUse } = await import('../../src/integrations/browser-use/index.js');
    const veto = {
      wrap: vi.fn((tools: Array<{ name: string }>) => tools.map((tool) => ({
        ...tool,
        handler: vi.fn().mockResolvedValue(undefined),
      }))),
      registerTools: vi.fn().mockResolvedValue(undefined),
    } as any;

    const controller = await wrapBrowserUse(veto, {
      validatedActions: new Set(['go_to_url']),
    });

    const result = await controller.act(new browserUse.RawAction('skip validation'), { tabId: 11 });

    expect(result).toEqual({
      source: 'super',
      actionName: 'raw_unvalidated',
      params: { note: 'skip validation' },
      browserContext: { tabId: 11 },
    });
    expect(controller.baseActCalls).toHaveLength(1);
  });
});
