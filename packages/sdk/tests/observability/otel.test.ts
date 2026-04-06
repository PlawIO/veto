import { describe, it, expect, vi } from 'vitest';
import { tryLoadOtel, SpanStatusCode } from '../../src/observability/otel.js';
import { ValidationEngine } from '../../src/core/validator.js';
import { createLogger } from '../../src/utils/logger.js';
import type { VetoTracer, VetoSpan } from '../../src/observability/otel.js';

describe('tryLoadOtel', () => {
  it('returns a no-op tracer when @opentelemetry/api is not installed', async () => {
    // The package is not installed in the test environment, so this exercises the catch path.
    const tracer = await tryLoadOtel('test-service');
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
  });

  it('returns a tracer whose startSpan returns a span with the required methods', async () => {
    const tracer = await tryLoadOtel();
    const span = tracer.startSpan('test.span');
    expect(typeof span.setAttribute).toBe('function');
    expect(typeof span.setStatus).toBe('function');
    expect(typeof span.end).toBe('function');
  });

  it('noop span methods do not throw', async () => {
    const tracer = await tryLoadOtel();
    const span = tracer.startSpan('test.span');
    expect(() => span.setAttribute('key', 'value')).not.toThrow();
    expect(() => span.setAttribute('num', 42)).not.toThrow();
    expect(() => span.setAttribute('bool', true)).not.toThrow();
    expect(() => span.setStatus({ code: SpanStatusCode.OK })).not.toThrow();
    expect(() => span.setStatus({ code: SpanStatusCode.ERROR, message: 'oops' })).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });
});

describe('SpanStatusCode', () => {
  it('defines OK as 1 and ERROR as 2', () => {
    expect(SpanStatusCode.OK).toBe(1);
    expect(SpanStatusCode.ERROR).toBe(2);
  });
});

describe('ValidationEngine with no tracer', () => {
  it('validates normally when otelTracer is null', async () => {
    const logger = createLogger('error', 'compact');
    const engine = new ValidationEngine({
      logger,
      defaultDecision: 'allow',
      otelTracer: null,
    });

    engine.addValidator({
      name: 'test-validator',
      validate: () => ({ decision: 'allow' }),
    });

    const result = await engine.validate({
      toolName: 'test_tool',
      arguments: { x: 1 },
      callId: 'call-1',
    });

    expect(result.finalResult.decision).toBe('allow');
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses default decision when no validators match and otelTracer is null', async () => {
    const logger = createLogger('error', 'compact');
    const engine = new ValidationEngine({
      logger,
      defaultDecision: 'deny',
      otelTracer: null,
    });

    const result = await engine.validate({
      toolName: 'any_tool',
      arguments: {},
      callId: 'call-2',
    });

    expect(result.finalResult.decision).toBe('deny');
  });
});

describe('ValidationEngine with noop tracer', () => {
  it('calls startSpan and end on the tracer during validation', async () => {
    const mockEnd = vi.fn();
    const mockSetAttribute = vi.fn();
    const mockSetStatus = vi.fn();

    const mockSpan: VetoSpan = {
      setAttribute: mockSetAttribute,
      setStatus: mockSetStatus,
      end: mockEnd,
    };

    const mockStartSpan = vi.fn().mockReturnValue(mockSpan);
    const mockTracer: VetoTracer = { startSpan: mockStartSpan };

    const logger = createLogger('error', 'compact');
    const engine = new ValidationEngine({
      logger,
      defaultDecision: 'allow',
      otelTracer: mockTracer,
    });

    engine.addValidator({
      name: 'allow-all',
      validate: () => ({ decision: 'allow' }),
    });

    await engine.validate({
      toolName: 'my_tool',
      arguments: { param: 'value' },
      callId: 'call-3',
    });

    expect(mockStartSpan).toHaveBeenCalledWith('veto.validate');
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockSetAttribute).toHaveBeenCalledWith('tool.name', 'my_tool');
    expect(mockSetAttribute).toHaveBeenCalledWith('veto.decision', 'allow');
  });

  it('sets veto.decision=deny on span when validator returns deny', async () => {
    const mockSetAttribute = vi.fn();
    const mockSpan: VetoSpan = {
      setAttribute: mockSetAttribute,
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer: VetoTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

    const logger = createLogger('error', 'compact');
    const engine = new ValidationEngine({
      logger,
      defaultDecision: 'allow',
      otelTracer: mockTracer,
    });

    engine.addValidator({
      name: 'deny-all',
      validate: () => ({ decision: 'deny', reason: 'blocked by policy' }),
    });

    const result = await engine.validate({
      toolName: 'risky_tool',
      arguments: {},
      callId: 'call-deny',
    });

    expect(result.finalResult.decision).toBe('deny');
    expect(mockSetAttribute).toHaveBeenCalledWith('veto.decision', 'deny');
  });

  it('records veto.decision=deny on span when validator throws (fail-safe path)', async () => {
    const mockSetAttribute = vi.fn();
    const mockSetStatus = vi.fn();
    const mockEnd = vi.fn();

    const mockSpan: VetoSpan = {
      setAttribute: mockSetAttribute,
      setStatus: mockSetStatus,
      end: mockEnd,
    };
    const mockTracer: VetoTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

    const logger = createLogger('error', 'compact');
    const engine = new ValidationEngine({
      logger,
      defaultDecision: 'allow',
      otelTracer: mockTracer,
    });

    // Engine catches validator errors and converts to deny (fail-safe, no rethrow)
    engine.addValidator({
      name: 'throwing-validator',
      validate: () => { throw new Error('unexpected failure'); },
    });

    const result = await engine.validate({
      toolName: 'boom_tool',
      arguments: {},
      callId: 'call-throw',
    });

    expect(result.finalResult.decision).toBe('deny');
    expect(mockSetAttribute).toHaveBeenCalledWith('veto.decision', 'deny');
    expect(mockEnd).toHaveBeenCalledTimes(1);
    // setStatus is NOT called — error was contained, this is not an engine-level failure
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('records veto.duration_ms as a number attribute', async () => {
    const mockSetAttribute = vi.fn();
    const mockSpan: VetoSpan = {
      setAttribute: mockSetAttribute,
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer: VetoTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

    const logger = createLogger('error', 'compact');
    const engine = new ValidationEngine({
      logger,
      defaultDecision: 'allow',
      otelTracer: mockTracer,
    });

    await engine.validate({
      toolName: 'fast_tool',
      arguments: {},
      callId: 'call-5',
    });

    const durationCall = mockSetAttribute.mock.calls.find(
      ([key]) => key === 'veto.duration_ms'
    );
    expect(durationCall).toBeDefined();
    expect(typeof durationCall?.[1]).toBe('number');
  });
});
