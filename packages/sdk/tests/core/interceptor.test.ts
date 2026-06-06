import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Interceptor, ToolCallDeniedError } from '../../src/core/interceptor.js';
import { ValidationEngine } from '../../src/core/validator.js';
import { HistoryTracker } from '../../src/core/history.js';
import type { ToolCall, ExecutableTool } from '../../src/types/tool.js';

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('Interceptor', () => {
  let interceptor: Interceptor;
  let engine: ValidationEngine;
  let history: HistoryTracker;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    engine = new ValidationEngine({
      logger: mockLogger,
      defaultDecision: 'allow',
    });
    history = new HistoryTracker({
      maxSize: 100,
      logger: mockLogger,
    });
    interceptor = new Interceptor({
      logger: mockLogger,
      validationEngine: engine,
      historyTracker: history,
    });
  });

  describe('intercept', () => {
    const testCall: ToolCall = {
      id: 'call_123',
      name: 'read_file',
      arguments: { path: '/test.txt' },
    };

    it('should allow calls when validation passes', async () => {
      engine.addValidator({
        name: 'allow-all',
        validate: () => ({ decision: 'allow' }),
      });

      const result = await interceptor.intercept(testCall);

      expect(result.allowed).toBe(true);
      expect(result.validationResult.decision).toBe('allow');
      expect(result.originalCall).toEqual(testCall);
    });

    it('should deny calls when validation fails', async () => {
      engine.addValidator({
        name: 'deny-all',
        validate: () => ({ decision: 'deny', reason: 'blocked' }),
      });

      const result = await interceptor.intercept(testCall);

      expect(result.allowed).toBe(false);
      expect(result.validationResult.decision).toBe('deny');
      expect(result.validationResult.reason).toBe('blocked');
    });

    it('should record calls in history', async () => {
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });

      await interceptor.intercept(testCall);

      expect(history.size()).toBe(1);
      const entries = history.getAll();
      expect(entries[0].toolName).toBe('read_file');
    });

    it('should handle modified arguments', async () => {
      engine.addValidator({
        name: 'modifier',
        validate: () => ({
          decision: 'modify',
          modifiedArguments: { path: '/sanitized.txt' },
        }),
      });

      const result = await interceptor.intercept(testCall);

      expect(result.allowed).toBe(true);
      expect(result.finalArguments).toEqual({ path: '/sanitized.txt' });
      expect(result.originalCall.arguments).toEqual({ path: '/test.txt' });
    });

    it('should generate call ID if not provided', async () => {
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });

      const callWithoutId: ToolCall = {
        name: 'test_tool',
        arguments: {},
      };

      const result = await interceptor.intercept(callWithoutId);

      expect(result.originalCall.name).toBe('test_tool');
      expect(result.aggregatedResult.validatorResults).toBeDefined();
    });

    it('should call onBeforeValidation hook', async () => {
      const beforeHook = vi.fn();
      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        onBeforeValidation: beforeHook,
      });

      await interceptor.intercept(testCall);

      expect(beforeHook).toHaveBeenCalledOnce();
      expect(beforeHook.mock.calls[0][0].toolName).toBe('read_file');
    });

    it('should call onAfterValidation hook', async () => {
      const afterHook = vi.fn();
      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        onAfterValidation: afterHook,
      });

      await interceptor.intercept(testCall);

      expect(afterHook).toHaveBeenCalledOnce();
    });

    it('should call onDenied hook when denied', async () => {
      const deniedHook = vi.fn();
      engine.addValidator({
        name: 'denier',
        validate: () => ({ decision: 'deny', reason: 'blocked' }),
      });
      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        onDenied: deniedHook,
      });

      await interceptor.intercept(testCall);

      expect(deniedHook).toHaveBeenCalledOnce();
    });

    it('should not call onDenied hook when allowed', async () => {
      const deniedHook = vi.fn();
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });
      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        onDenied: deniedHook,
      });

      await interceptor.intercept(testCall);

      expect(deniedHook).not.toHaveBeenCalled();
    });

    it('should continue if hooks throw', async () => {
      const throwingHook = vi.fn().mockImplementation(() => {
        throw new Error('Hook error');
      });

      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        onBeforeValidation: throwingHook,
      });

      const result = await interceptor.intercept(testCall);

      expect(result.allowed).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('interceptOrThrow', () => {
    const testCall: ToolCall = {
      id: 'call_456',
      name: 'write_file',
      arguments: { path: '/test.txt', content: 'hello' },
    };

    it('should return result when allowed', async () => {
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });

      const result = await interceptor.interceptOrThrow(testCall);

      expect(result.allowed).toBe(true);
    });

    it('should throw ToolCallDeniedError when denied', async () => {
      engine.addValidator({
        name: 'denier',
        validate: () => ({ decision: 'deny', reason: 'not allowed' }),
      });

      await expect(interceptor.interceptOrThrow(testCall)).rejects.toThrow(
        ToolCallDeniedError
      );
    });

    it('should include details in ToolCallDeniedError', async () => {
      engine.addValidator({
        name: 'denier',
        validate: () => ({ decision: 'deny', reason: 'security violation' }),
      });

      try {
        await interceptor.interceptOrThrow(testCall);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolCallDeniedError);
        const denied = error as ToolCallDeniedError;
        expect(denied.toolName).toBe('write_file');
        expect(denied.callId).toBe('call_456');
        expect(denied.reason).toBe('security violation');
        expect(denied.validationResult.decision).toBe('deny');
      }
    });
  });

  describe('interceptAndExecute', () => {
    const testCall: ToolCall = {
      id: 'call_789',
      name: 'get_time',
      arguments: {},
    };

    const tools: ExecutableTool[] = [
      {
        name: 'get_time',
        inputSchema: { type: 'object' },
        handler: vi.fn().mockResolvedValue({ time: '12:00' }),
      },
    ];

    it('should execute tool when allowed', async () => {
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });

      const result = await interceptor.interceptAndExecute(testCall, tools);

      expect(result.isError).toBe(false);
      expect(result.content).toEqual({ time: '12:00' });
      expect(result.toolCallId).toBe('call_789');
    });

    it('should return error when denied', async () => {
      engine.addValidator({
        name: 'denier',
        validate: () => ({ decision: 'deny', reason: 'blocked' }),
      });

      const result = await interceptor.interceptAndExecute(testCall, tools);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveProperty('error', 'Tool call denied');
      expect(result.content).toHaveProperty('reason', 'blocked');
    });

    it('should return error when tool not found', async () => {
      const unknownCall: ToolCall = {
        id: 'call_unknown',
        name: 'unknown_tool',
        arguments: {},
      };

      const result = await interceptor.interceptAndExecute(unknownCall, tools);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveProperty('error', 'Tool not found');
    });

    it('should handle tool execution errors', async () => {
      const throwingTools: ExecutableTool[] = [
        {
          name: 'failing_tool',
          inputSchema: { type: 'object' },
          handler: vi.fn().mockRejectedValue(new Error('Execution failed')),
        },
      ];

      const failingCall: ToolCall = {
        id: 'call_fail',
        name: 'failing_tool',
        arguments: {},
      };

      const result = await interceptor.interceptAndExecute(failingCall, throwingTools);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveProperty('error', 'Tool execution failed');
      expect(result.content).toHaveProperty('message', 'Execution failed');
    });

    it('should use modified arguments when executing', async () => {
      engine.addValidator({
        name: 'modifier',
        validate: () => ({
          decision: 'modify',
          modifiedArguments: { modified: true },
        }),
      });

      const capturingTool: ExecutableTool = {
        name: 'capturing_tool',
        inputSchema: { type: 'object' },
        handler: vi.fn().mockResolvedValue('done'),
      };

      const call: ToolCall = {
        id: 'call_mod',
        name: 'capturing_tool',
        arguments: { original: true },
      };

      await interceptor.interceptAndExecute(call, [capturingTool]);

      expect(capturingTool.handler).toHaveBeenCalledWith({ modified: true });
    });

    it('should return transformed output from output validator', async () => {
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });

      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        outputValidator: {
          validate: () => ({
            decision: 'allow',
            output: { time: '[REDACTED]' },
            matchedRuleIds: ['redact-time'],
            liftedRuleIds: [],
            redactions: 1,
            trace: [],
            liftTrace: [],
          }),
        },
      });

      const result = await interceptor.interceptAndExecute(testCall, tools);

      expect(result.isError).toBe(false);
      expect(result.content).toEqual({ time: '[REDACTED]' });
    });

    it('should block output when output validator returns block', async () => {
      engine.addValidator({
        name: 'allow',
        validate: () => ({ decision: 'allow' }),
      });

      interceptor = new Interceptor({
        logger: mockLogger,
        validationEngine: engine,
        outputValidator: {
          validate: () => ({
            decision: 'block',
            output: null,
            reason: 'Output contains sensitive data',
            matchedRuleIds: ['block-sensitive-output'],
            liftedRuleIds: [],
            redactions: 0,
            trace: [],
            liftTrace: [],
          }),
        },
      });

      const result = await interceptor.interceptAndExecute(testCall, tools);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveProperty('error', 'Tool output blocked');
      expect(result.content).toHaveProperty('reason', 'Output contains sensitive data');
    });
  });
});

describe('ToolCallDeniedError', () => {
  it('should have correct properties', () => {
    const error = new ToolCallDeniedError('test_tool', 'call_123', {
      decision: 'deny',
      reason: 'test reason',
    });

    expect(error.name).toBe('ToolCallDeniedError');
    expect(error.toolName).toBe('test_tool');
    expect(error.callId).toBe('call_123');
    expect(error.reason).toBe('test reason');
    expect(error.message).toBe('Tool call denied: test_tool - test reason');
  });

  it('should use default reason when not provided', () => {
    const error = new ToolCallDeniedError('test_tool', 'call_123', {
      decision: 'deny',
    });

    expect(error.reason).toBe('Tool call denied');
  });
});
