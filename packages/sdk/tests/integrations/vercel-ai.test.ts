import { describe, it, expect, vi } from 'vitest';
import { createVetoMiddleware } from '../../src/integrations/vercel-ai/middleware.js';

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

describe('Vercel AI SDK Middleware', () => {
  describe('createVetoMiddleware', () => {
    it('should return a middleware with specificationVersion v3', () => {
      const veto = createMockVeto();
      const middleware = createVetoMiddleware(veto);

      expect(middleware.specificationVersion).toBe('v3');
      expect(middleware.wrapGenerate).toBeTypeOf('function');
      expect(middleware.wrapStream).toBeTypeOf('function');
    });
  });

  describe('wrapGenerate', () => {
    it('should allow tool calls that pass validation', async () => {
      const veto = createMockVeto('allow');
      const middleware = createVetoMiddleware(veto);

      const mockResult = {
        content: [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'tc_1',
            toolName: 'search',
            args: '{"query":"hello"}',
          },
        ],
      };

      const doGenerate = vi.fn().mockResolvedValue(mockResult);
      const doStream = vi.fn();

      const result = await middleware.wrapGenerate!({
        doGenerate,
        doStream,
        params: {},
        model: {},
      });

      expect(result.content).toHaveLength(1);
      expect(veto.validateToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'search',
          arguments: { query: 'hello' },
        }),
      );
    });

    it('should throw ToolCallDeniedError for denied tool calls', async () => {
      const veto = createMockVeto('deny', 'Not allowed');
      const middleware = createVetoMiddleware(veto);

      const mockResult = {
        content: [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'tc_1',
            toolName: 'delete_file',
            args: '{"path":"/etc/passwd"}',
          },
        ],
      };

      const doGenerate = vi.fn().mockResolvedValue(mockResult);

      await expect(
        middleware.wrapGenerate!({ doGenerate, doStream: vi.fn(), params: {}, model: {} }),
      ).rejects.toThrow('Tool call denied: delete_file');
    });

    it('should update args when validation modifies arguments', async () => {
      const veto = {
        validateToolCall: vi.fn().mockResolvedValue({
          allowed: true,
          validationResult: { decision: 'allow' },
          originalCall: { id: 'tc_1', name: 'send_email', arguments: {} },
          finalArguments: { to: 'safe@example.com', body: 'sanitized' },
        }),
      } as any;

      const middleware = createVetoMiddleware(veto);

      const toolCallPart = {
        type: 'tool-call',
        toolCallType: 'function',
        toolCallId: 'tc_1',
        toolName: 'send_email',
        args: '{"to":"user@example.com","body":"original"}',
      };

      const mockResult = { content: [toolCallPart] };
      const doGenerate = vi.fn().mockResolvedValue(mockResult);

      await middleware.wrapGenerate!({ doGenerate, doStream: vi.fn(), params: {}, model: {} });

      expect(toolCallPart.args).toBe('{"to":"safe@example.com","body":"sanitized"}');
    });

    it('should skip non-tool-call content parts', async () => {
      const veto = createMockVeto('allow');
      const middleware = createVetoMiddleware(veto);

      const mockResult = {
        content: [
          { type: 'text', text: 'Hello world' },
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'tc_1',
            toolName: 'search',
            args: '{"q":"test"}',
          },
        ],
      };

      const doGenerate = vi.fn().mockResolvedValue(mockResult);

      await middleware.wrapGenerate!({ doGenerate, doStream: vi.fn(), params: {}, model: {} });

      expect(veto.validateToolCall).toHaveBeenCalledTimes(1);
    });

    it('should call onAllow callback for allowed tool calls', async () => {
      const veto = createMockVeto('allow');
      const onAllow = vi.fn();
      const middleware = createVetoMiddleware(veto, { onAllow });

      const mockResult = {
        content: [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'tc_1',
            toolName: 'search',
            args: '{"query":"test"}',
          },
        ],
      };

      await middleware.wrapGenerate!({
        doGenerate: vi.fn().mockResolvedValue(mockResult),
        doStream: vi.fn(),
        params: {},
        model: {},
      });

      expect(onAllow).toHaveBeenCalledWith('search', { query: 'test' });
    });

    it('should call onDeny callback for denied tool calls', async () => {
      const veto = createMockVeto('deny', 'Blocked by policy');
      const onDeny = vi.fn();
      const middleware = createVetoMiddleware(veto, { onDeny });

      const mockResult = {
        content: [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'tc_1',
            toolName: 'delete_file',
            args: '{"path":"/tmp"}',
          },
        ],
      };

      await expect(
        middleware.wrapGenerate!({
          doGenerate: vi.fn().mockResolvedValue(mockResult),
          doStream: vi.fn(),
          params: {},
          model: {},
        }),
      ).rejects.toThrow();

      expect(onDeny).toHaveBeenCalledWith('delete_file', { path: '/tmp' }, 'Blocked by policy');
    });
  });

  describe('wrapStream', () => {
    function createReadableStream(chunks: any[]): ReadableStream {
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    }

    async function collectStream(stream: ReadableStream): Promise<any[]> {
      const reader = stream.getReader();
      const chunks: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      return chunks;
    }

    it('should pass through allowed tool calls in stream', async () => {
      const veto = createMockVeto('allow');
      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'text-delta', text: 'Hello' },
        { type: 'tool-input-start', id: 'tc_1', toolName: 'search' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '{"query":' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '"test"}' },
        { type: 'tool-input-end', id: 'tc_1' },
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'search', input: '{"query":"test"}' },
        { type: 'finish', usage: { promptTokens: 10, completionTokens: 5 } },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      expect(chunks.some(c => c.type === 'tool-call')).toBe(true);
      expect(veto.validateToolCall).toHaveBeenCalledTimes(1);
    });

    it('should drop denied tool calls from stream by default', async () => {
      const veto = createMockVeto('deny', 'Not allowed');
      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'text-delta', text: 'Let me delete that' },
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'delete_file', input: '{"path":"/tmp"}' },
        { type: 'finish', usage: {} },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      expect(chunks.filter(c => c.type === 'tool-call')).toHaveLength(0);
      expect(chunks.some(c => c.type === 'text-delta')).toBe(true);
    });

    it('should not emit orphaned tool-input events for denied calls', async () => {
      const veto = createMockVeto('deny', 'Not allowed');
      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'text-delta', text: 'Hello' },
        { type: 'tool-input-start', id: 'tc_1', toolName: 'delete_file' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '{"path":' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '"/tmp"}' },
        { type: 'tool-input-end', id: 'tc_1' },
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'delete_file', input: '{"path":"/tmp"}' },
        { type: 'finish', usage: {} },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      expect(chunks.filter(c => c.type === 'tool-input-start')).toHaveLength(0);
      expect(chunks.filter(c => c.type === 'tool-input-delta')).toHaveLength(0);
      expect(chunks.filter(c => c.type === 'tool-input-end')).toHaveLength(0);
      expect(chunks.filter(c => c.type === 'tool-call')).toHaveLength(0);
      expect(chunks.some(c => c.type === 'text-delta')).toBe(true);
    });

    it('should emit buffered tool-input events for allowed calls with unmodified args', async () => {
      const veto = {
        validateToolCall: vi.fn().mockResolvedValue({
          allowed: true,
          validationResult: { decision: 'allow' },
          originalCall: { id: 'tc_1', name: 'search', arguments: { q: 'test' } },
          finalArguments: { q: 'test' },
        }),
      } as any;
      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'tool-input-start', id: 'tc_1', toolName: 'search' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '{"q":"test"}' },
        { type: 'tool-input-end', id: 'tc_1' },
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'search', input: '{"q":"test"}' },
        { type: 'finish', usage: {} },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      expect(chunks.filter(c => c.type === 'tool-input-start')).toHaveLength(1);
      expect(chunks.filter(c => c.type === 'tool-input-delta')).toHaveLength(1);
      expect(chunks.filter(c => c.type === 'tool-input-end')).toHaveLength(1);
      expect(chunks.filter(c => c.type === 'tool-call')).toHaveLength(1);
    });

    it('should skip buffered tool-input events when args are modified', async () => {
      const veto = {
        validateToolCall: vi.fn().mockResolvedValue({
          allowed: true,
          validationResult: { decision: 'allow' },
          originalCall: { id: 'tc_1', name: 'send_email', arguments: {} },
          finalArguments: { to: 'safe@example.com', body: 'sanitized' },
        }),
      } as any;

      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'tool-input-start', id: 'tc_1', toolName: 'send_email' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '{"to":"evil@example.com",' },
        { type: 'tool-input-delta', id: 'tc_1', delta: '"body":"original"}' },
        { type: 'tool-input-end', id: 'tc_1' },
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'send_email', input: '{"to":"evil@example.com","body":"original"}' },
        { type: 'finish', usage: {} },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      // Buffered events should be skipped since args were modified
      expect(chunks.filter(c => c.type === 'tool-input-start')).toHaveLength(0);
      expect(chunks.filter(c => c.type === 'tool-input-delta')).toHaveLength(0);
      expect(chunks.filter(c => c.type === 'tool-input-end')).toHaveLength(0);
      // Only the modified tool-call should be emitted
      const toolCalls = chunks.filter(c => c.type === 'tool-call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].input).toBe('{"to":"safe@example.com","body":"sanitized"}');
    });

    it('should throw on denied tool calls when throwOnDeny is true', async () => {
      const veto = createMockVeto('deny', 'Blocked');
      const middleware = createVetoMiddleware(veto, { throwOnDeny: true });

      const stream = createReadableStream([
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'delete_file', input: '{"path":"/tmp"}' },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      await expect(collectStream(result.stream)).rejects.toThrow('Tool call denied');
    });

    it('should handle multiple tool calls in a single stream', async () => {
      const veto = {
        validateToolCall: vi.fn().mockImplementation(async (call: any) => {
          const deny = call.name === 'delete_file';
          return {
            allowed: !deny,
            validationResult: { decision: deny ? 'deny' : 'allow', reason: deny ? 'blocked' : undefined },
            originalCall: call,
            finalArguments: call.arguments,
          };
        }),
      } as any;

      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'search', input: '{"q":"test"}' },
        { type: 'tool-call', toolCallId: 'tc_2', toolName: 'delete_file', input: '{"path":"/tmp"}' },
        { type: 'tool-call', toolCallId: 'tc_3', toolName: 'read_file', input: '{"path":"readme.md"}' },
        { type: 'finish', usage: {} },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      const toolCalls = chunks.filter(c => c.type === 'tool-call');
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].toolName).toBe('search');
      expect(toolCalls[1].toolName).toBe('read_file');
      expect(veto.validateToolCall).toHaveBeenCalledTimes(3);
    });

    it('should handle malformed JSON args gracefully', async () => {
      const veto = createMockVeto('allow');
      const middleware = createVetoMiddleware(veto);

      const stream = createReadableStream([
        { type: 'tool-call', toolCallId: 'tc_1', toolName: 'search', input: 'not-json' },
        { type: 'finish', usage: {} },
      ]);

      const result = await middleware.wrapStream!({
        doStream: vi.fn().mockResolvedValue({ stream }),
        doGenerate: vi.fn(),
        params: {},
        model: {},
      });

      const chunks = await collectStream(result.stream);

      expect(chunks.some(c => c.type === 'tool-call')).toBe(true);
      expect(veto.validateToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ arguments: {} }),
      );
    });
  });
});
