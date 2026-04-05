import { describe, it, expect } from 'vitest';
import {
  parseSSELine,
  mergeToolCallDeltas,
  finalizeToolCall,
  synthBlockedEvent,
  type PendingToolCall,
} from '../../src/proxy/interceptor.js';

describe('parseSSELine', () => {
  it('parses data: [DONE] as done', () => {
    const result = parseSSELine('data: [DONE]');
    expect(result.done).toBe(true);
  });

  it('returns line unchanged for comment/blank lines', () => {
    const result = parseSSELine(': keep-alive');
    expect(result.line).toBe(': keep-alive');
    expect(result.data).toBeUndefined();
  });

  it('parses a content delta with no tool calls', () => {
    const chunk = JSON.stringify({
      choices: [{ delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
    });
    const result = parseSSELine(`data: ${chunk}`);
    expect(result.hasToolCalls).toBeFalsy();
    expect(result.finishReasonToolCalls).toBeFalsy();
    expect(result.data).toBeDefined();
  });

  it('detects tool_calls in delta', () => {
    const chunk = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'search_web', arguments: '' } }],
          },
          finish_reason: null,
        },
      ],
    });
    const result = parseSSELine(`data: ${chunk}`);
    expect(result.hasToolCalls).toBe(true);
    expect(result.finishReasonToolCalls).toBeFalsy();
  });

  it('detects finish_reason: tool_calls', () => {
    const chunk = JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    });
    const result = parseSSELine(`data: ${chunk}`);
    expect(result.finishReasonToolCalls).toBe(true);
  });

  it('returns line for malformed JSON', () => {
    const result = parseSSELine('data: {invalid}');
    expect(result.data).toBeUndefined();
    expect(result.line).toBe('data: {invalid}');
  });
});

describe('mergeToolCallDeltas', () => {
  it('accumulates argument chunks across multiple deltas', () => {
    const pending = new Map<number, PendingToolCall>();

    const delta1 = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'tc_1', function: { name: 'search_web', arguments: '{"q' } },
            ],
          },
        },
      ],
    };
    mergeToolCallDeltas(pending, delta1);
    expect(pending.get(0)?.argumentsRaw).toBe('{"q');
    expect(pending.get(0)?.name).toBe('search_web');

    const delta2 = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'uery":"foo"}' } },
            ],
          },
        },
      ],
    };
    mergeToolCallDeltas(pending, delta2);
    expect(pending.get(0)?.argumentsRaw).toBe('{"query":"foo"}');
  });

  it('handles multiple tool calls at different indexes', () => {
    const pending = new Map<number, PendingToolCall>();
    const data = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'tc_0', function: { name: 'tool_a', arguments: '{}' } },
              { index: 1, id: 'tc_1', function: { name: 'tool_b', arguments: '{"x":1}' } },
            ],
          },
        },
      ],
    };
    mergeToolCallDeltas(pending, data);
    expect(pending.size).toBe(2);
    expect(pending.get(0)?.name).toBe('tool_a');
    expect(pending.get(1)?.name).toBe('tool_b');
  });
});

describe('finalizeToolCall', () => {
  it('parses valid JSON arguments', () => {
    const tc: PendingToolCall = { index: 0, id: 'tc_1', name: 'search_web', argumentsRaw: '{"query":"cats"}' };
    const result = finalizeToolCall(tc);
    expect(result.arguments).toEqual({ query: 'cats' });
    expect(result.name).toBe('search_web');
  });

  it('returns empty args for malformed JSON', () => {
    const tc: PendingToolCall = { index: 0, id: 'tc_1', name: 'search_web', argumentsRaw: '{"unclosed' };
    const result = finalizeToolCall(tc);
    expect(result.arguments).toEqual({});
  });

  it('returns empty args for array JSON (not object)', () => {
    const tc: PendingToolCall = { index: 0, id: 'tc_1', name: 'search_web', argumentsRaw: '[1,2]' };
    const result = finalizeToolCall(tc);
    expect(result.arguments).toEqual({});
  });
});

describe('synthBlockedEvent', () => {
  it('returns valid SSE format ending with [DONE]', () => {
    const output = synthBlockedEvent('Too many requests');
    expect(output).toContain('data: ');
    expect(output).toContain('data: [DONE]');
    expect(output).toContain('[BLOCKED by veto]');
    expect(output).toContain('Too many requests');
  });

  it('parses as valid JSON SSE data', () => {
    const output = synthBlockedEvent('test reason');
    const lines = output.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
    expect(lines.length).toBeGreaterThan(0);
    const json = JSON.parse(lines[0].slice(6)) as Record<string, unknown>;
    expect(json['choices']).toBeDefined();
  });
});
