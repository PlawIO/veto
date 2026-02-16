import { describe, it, expect, vi } from 'vitest';
import { createVetoLangChainMiddleware } from '../../src/integrations/langchain/middleware.js';
import { createVetoToolNode } from '../../src/integrations/langchain/tool-node.js';
import { createVetoCallbackHandler } from '../../src/integrations/langchain/callback.js';

function createMockVeto(decision: 'allow' | 'deny' = 'allow', reason?: string) {
  return {
    validateToolCall: vi.fn().mockResolvedValue({
      allowed: decision !== 'deny',
      validationResult: { decision, reason },
      originalCall: { id: 'call_123', name: 'test', arguments: {} },
      finalArguments: { modified: true },
    }),
  } as any;
}

describe('LangChain Middleware', () => {
  describe('createVetoLangChainMiddleware', () => {
    it('should return a middleware with name and wrapToolCall', () => {
      const veto = createMockVeto();
      const middleware = createVetoLangChainMiddleware(veto);

      expect(middleware.name).toBe('VetoGuardrail');
      expect(middleware.wrapToolCall).toBeTypeOf('function');
    });

    it('should pass through allowed tool calls to handler', async () => {
      const veto = createMockVeto('allow');
      const middleware = createVetoLangChainMiddleware(veto);

      const handler = vi.fn().mockResolvedValue({ content: 'result' });
      const request = {
        toolCall: { name: 'search', args: { query: 'test' }, id: 'tc_1' },
      };

      await middleware.wrapToolCall(request, handler);

      expect(handler).toHaveBeenCalled();
      expect(veto.validateToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'search', arguments: { query: 'test' } }),
      );
    });

    it('should block denied tool calls without calling handler', async () => {
      const veto = createMockVeto('deny', 'Blocked by policy');
      const middleware = createVetoLangChainMiddleware(veto);

      const handler = vi.fn();
      const request = {
        toolCall: { name: 'delete_file', args: { path: '/tmp' }, id: 'tc_1' },
      };

      const denied = await middleware.wrapToolCall(request, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(denied).toHaveProperty('content');
      expect(denied.content).toContain('Tool call denied by Veto');
    });

    it('should throw ToolCallDeniedError when throwOnDeny is true', async () => {
      const veto = createMockVeto('deny', 'Blocked');
      const middleware = createVetoLangChainMiddleware(veto, { throwOnDeny: true });

      const handler = vi.fn();
      const request = {
        toolCall: { name: 'delete_file', args: { path: '/tmp' }, id: 'tc_1' },
      };

      await expect(middleware.wrapToolCall(request, handler)).rejects.toThrow(
        'Tool call denied: delete_file',
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it('should call onAllow callback for allowed calls', async () => {
      const veto = createMockVeto('allow');
      const onAllow = vi.fn();
      const middleware = createVetoLangChainMiddleware(veto, { onAllow });

      const handler = vi.fn().mockResolvedValue({ content: 'ok' });
      const request = {
        toolCall: { name: 'search', args: { query: 'hello' }, id: 'tc_1' },
      };

      await middleware.wrapToolCall(request, handler);

      expect(onAllow).toHaveBeenCalledWith('search', { query: 'hello' });
    });

    it('should call onDeny callback for denied calls', async () => {
      const veto = createMockVeto('deny', 'Not allowed');
      const onDeny = vi.fn();
      const middleware = createVetoLangChainMiddleware(veto, { onDeny });

      const handler = vi.fn();
      const request = {
        toolCall: { name: 'delete_file', args: { path: '/root' }, id: 'tc_1' },
      };

      await middleware.wrapToolCall(request, handler);

      expect(onDeny).toHaveBeenCalledWith('delete_file', { path: '/root' }, 'Not allowed');
    });

    it('should forward modified arguments to handler', async () => {
      const modifiedArgs = { query: 'sanitized' };
      const veto = {
        validateToolCall: vi.fn().mockResolvedValue({
          allowed: true,
          validationResult: { decision: 'allow' },
          originalCall: { id: 'tc_1', name: 'search', arguments: {} },
          finalArguments: modifiedArgs,
        }),
      } as any;

      const middleware = createVetoLangChainMiddleware(veto);

      const handler = vi.fn().mockResolvedValue({ content: 'ok' });
      const request = {
        toolCall: { name: 'search', args: { query: 'original' }, id: 'tc_1' },
      };

      await middleware.wrapToolCall(request, handler);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: expect.objectContaining({ args: modifiedArgs }),
        }),
      );
    });

    it('should generate a call ID when none is provided', async () => {
      const veto = createMockVeto('allow');
      const middleware = createVetoLangChainMiddleware(veto);

      const handler = vi.fn().mockResolvedValue({ content: 'ok' });
      const request = {
        toolCall: { name: 'search', args: { query: 'test' } },
      };

      await middleware.wrapToolCall(request, handler);

      const callArg = veto.validateToolCall.mock.calls[0][0];
      expect(callArg.id).toBeTruthy();
      expect(callArg.id).toMatch(/^call_/);
    });
  });
});

describe('LangGraph ToolNode Wrapper', () => {
  describe('createVetoToolNode', () => {
    it('should delegate to toolNode when all calls are allowed', async () => {
      const veto = createMockVeto('allow');
      const toolNode = { invoke: vi.fn().mockResolvedValue({ messages: [{ content: 'result' }] }) };
      const vetoNode = createVetoToolNode(veto, toolNode);

      const state = {
        messages: [
          {
            tool_calls: [
              { name: 'search', args: { query: 'test' }, id: 'tc_1' },
            ],
          },
        ],
      };

      const result = await vetoNode(state);

      expect(toolNode.invoke).toHaveBeenCalledWith(state);
    });

    it('should return denied messages when a tool call is blocked', async () => {
      const veto = createMockVeto('deny', 'Blocked');
      const toolNode = { invoke: vi.fn() };
      const vetoNode = createVetoToolNode(veto, toolNode);

      const state = {
        messages: [
          {
            tool_calls: [
              { name: 'delete_file', args: { path: '/tmp' }, id: 'tc_1' },
            ],
          },
        ],
      };

      const result = await vetoNode(state);

      expect(toolNode.invoke).not.toHaveBeenCalled();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain('Tool call denied by Veto');
    });

    it('should delegate when no tool_calls present', async () => {
      const veto = createMockVeto('allow');
      const toolNode = { invoke: vi.fn().mockResolvedValue({ messages: [] }) };
      const vetoNode = createVetoToolNode(veto, toolNode);

      const state = { messages: [{ content: 'Hello' }] };

      await vetoNode(state);

      expect(toolNode.invoke).toHaveBeenCalledWith(state);
      expect(veto.validateToolCall).not.toHaveBeenCalled();
    });

    it('should call onAllow for allowed calls', async () => {
      const veto = createMockVeto('allow');
      const onAllow = vi.fn();
      const toolNode = { invoke: vi.fn().mockResolvedValue({ messages: [] }) };
      const vetoNode = createVetoToolNode(veto, toolNode, { onAllow });

      const state = {
        messages: [
          { tool_calls: [{ name: 'search', args: { q: 'hi' }, id: 'tc_1' }] },
        ],
      };

      await vetoNode(state);

      expect(onAllow).toHaveBeenCalledWith('search', { q: 'hi' });
    });

    it('should call onDeny for denied calls', async () => {
      const veto = createMockVeto('deny', 'Not allowed');
      const onDeny = vi.fn();
      const toolNode = { invoke: vi.fn() };
      const vetoNode = createVetoToolNode(veto, toolNode, { onDeny });

      const state = {
        messages: [
          { tool_calls: [{ name: 'rm', args: {}, id: 'tc_1' }] },
        ],
      };

      await vetoNode(state);

      expect(onDeny).toHaveBeenCalledWith('rm', {}, 'Not allowed');
    });

    it('should execute allowed calls and return denial messages for denied ones on partial denial', async () => {
      const veto = {
        validateToolCall: vi.fn()
          .mockResolvedValueOnce({
            allowed: true,
            validationResult: { decision: 'allow' },
            originalCall: { id: 'tc_1', name: 'search', arguments: {} },
            finalArguments: {},
          })
          .mockResolvedValueOnce({
            allowed: false,
            validationResult: { decision: 'deny', reason: 'Blocked' },
            originalCall: { id: 'tc_2', name: 'delete_file', arguments: {} },
            finalArguments: {},
          })
          .mockResolvedValueOnce({
            allowed: true,
            validationResult: { decision: 'allow' },
            originalCall: { id: 'tc_3', name: 'read_file', arguments: {} },
            finalArguments: {},
          }),
      } as any;

      const toolNode = {
        invoke: vi.fn().mockResolvedValue({
          messages: [
            { content: 'search result', tool_call_id: 'tc_1' },
            { content: 'file content', tool_call_id: 'tc_3' },
          ],
        }),
      };
      const vetoNode = createVetoToolNode(veto, toolNode);

      const state = {
        messages: [
          {
            tool_calls: [
              { name: 'search', args: { q: 'test' }, id: 'tc_1' },
              { name: 'delete_file', args: { path: '/tmp' }, id: 'tc_2' },
              { name: 'read_file', args: { path: 'readme' }, id: 'tc_3' },
            ],
          },
        ],
      };

      const result = await vetoNode(state);

      expect(veto.validateToolCall).toHaveBeenCalledTimes(3);
      // toolNode invoked with only allowed calls
      expect(toolNode.invoke).toHaveBeenCalledTimes(1);
      const invokedState = toolNode.invoke.mock.calls[0][0];
      expect(invokedState.messages[0].tool_calls).toHaveLength(2);
      expect(invokedState.messages[0].tool_calls[0].name).toBe('search');
      expect(invokedState.messages[0].tool_calls[1].name).toBe('read_file');
      // Merged results: 1 denial + 2 allowed
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toContain('Blocked');
      expect(result.messages[0].tool_call_id).toBe('tc_2');
      expect(result.messages[1].content).toBe('search result');
      expect(result.messages[2].content).toBe('file content');
    });

    it('should return denial messages for multiple denied calls', async () => {
      const veto = {
        validateToolCall: vi.fn()
          .mockResolvedValueOnce({
            allowed: false,
            validationResult: { decision: 'deny', reason: 'No search' },
            originalCall: { id: 'tc_1', name: 'search', arguments: {} },
            finalArguments: {},
          })
          .mockResolvedValueOnce({
            allowed: false,
            validationResult: { decision: 'deny', reason: 'No delete' },
            originalCall: { id: 'tc_2', name: 'delete_file', arguments: {} },
            finalArguments: {},
          }),
      } as any;

      const toolNode = { invoke: vi.fn() };
      const vetoNode = createVetoToolNode(veto, toolNode);

      const state = {
        messages: [
          {
            tool_calls: [
              { name: 'search', args: {}, id: 'tc_1' },
              { name: 'delete_file', args: {}, id: 'tc_2' },
            ],
          },
        ],
      };

      const result = await vetoNode(state);

      expect(veto.validateToolCall).toHaveBeenCalledTimes(2);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toContain('No search');
      expect(result.messages[0].tool_call_id).toBe('tc_1');
      expect(result.messages[1].content).toContain('No delete');
      expect(result.messages[1].tool_call_id).toBe('tc_2');
      expect(toolNode.invoke).not.toHaveBeenCalled();
    });
  });
});

describe('LangChain Callback Handler', () => {
  describe('createVetoCallbackHandler', () => {
    it('should call onToolStart with tool name', async () => {
      const onToolStart = vi.fn();
      const handler = createVetoCallbackHandler({ onToolStart });

      await handler.handleToolStart({ name: 'search' }, '{"query":"test"}');

      expect(onToolStart).toHaveBeenCalledWith('search', '{"query":"test"}');
    });

    it('should call onToolEnd with output and preserve tool name via runId', async () => {
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const handler = createVetoCallbackHandler({ onToolStart, onToolEnd });

      await handler.handleToolStart({ name: 'search' }, '{"q":"test"}', 'run_1');
      await handler.handleToolEnd('result data', 'run_1');

      expect(onToolEnd).toHaveBeenCalledWith('search', 'result data');
    });

    it('should call onToolEnd with empty name when no runId', async () => {
      const onToolEnd = vi.fn();
      const handler = createVetoCallbackHandler({ onToolEnd });

      await handler.handleToolEnd('result data');

      expect(onToolEnd).toHaveBeenCalledWith('', 'result data');
    });

    it('should call onToolError with error and preserve tool name via runId', async () => {
      const onToolStart = vi.fn();
      const onToolError = vi.fn();
      const handler = createVetoCallbackHandler({ onToolStart, onToolError });

      const error = new Error('Something failed');
      await handler.handleToolStart({ name: 'dangerous_tool' }, '{}', 'run_2');
      await handler.handleToolError(error, 'run_2');

      expect(onToolError).toHaveBeenCalledWith('dangerous_tool', error);
    });

    it('should call onToolError with empty name when no runId', async () => {
      const onToolError = vi.fn();
      const handler = createVetoCallbackHandler({ onToolError });

      const error = new Error('Something failed');
      await handler.handleToolError(error);

      expect(onToolError).toHaveBeenCalledWith('', error);
    });

    it('should handle missing tool name gracefully', async () => {
      const onToolStart = vi.fn();
      const handler = createVetoCallbackHandler({ onToolStart });

      await handler.handleToolStart({}, '{}');

      expect(onToolStart).toHaveBeenCalledWith('unknown', '{}');
    });
  });
});
