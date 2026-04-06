import { describe, it, expect } from 'vitest';
import {
  parseAnthropicSSELines,
  mergeAnthropicToolUseDelta,
  finalizeAnthropicToolUse,
  synthAnthropicBlockedEvent,
  type AnthropicPendingToolUse,
} from '../../src/proxy/anthropic-interceptor.js';

describe('parseAnthropicSSELines', () => {
  it('detects content_block_start with tool_use', () => {
    const lines = [
      'event: content_block_start',
      `data: ${JSON.stringify({
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_web', input: '' },
      })}`,
    ];
    const result = parseAnthropicSSELines(lines);
    expect(result.hasToolUse).toBe(true);
    expect(result.eventType).toBe('content_block_start');
    expect(result.data).toBeDefined();
  });

  it('detects content_block_delta with input_json_delta', () => {
    const lines = [
      'event: content_block_delta',
      `data: ${JSON.stringify({
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":' },
      })}`,
    ];
    const result = parseAnthropicSSELines(lines);
    expect(result.hasToolUse).toBe(true);
    expect(result.eventType).toBe('content_block_delta');
  });

  it('detects content_block_stop', () => {
    const lines = [
      'event: content_block_stop',
      `data: ${JSON.stringify({ index: 0 })}`,
    ];
    const result = parseAnthropicSSELines(lines);
    expect(result.toolUseStop).toBe(true);
    expect(result.hasToolUse).toBeFalsy();
  });

  it('detects message_stop', () => {
    const lines = [
      'event: message_stop',
      'data: {}',
    ];
    const result = parseAnthropicSSELines(lines);
    expect(result.messageStop).toBe(true);
  });

  it('returns raw line for non-tool text block events', () => {
    const lines = [
      'event: content_block_start',
      `data: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}`,
    ];
    const result = parseAnthropicSSELines(lines);
    expect(result.hasToolUse).toBeFalsy();
    expect(result.data).toBeDefined();
  });

  it('handles malformed JSON gracefully', () => {
    const lines = [
      'event: content_block_start',
      'data: {broken',
    ];
    const result = parseAnthropicSSELines(lines);
    expect(result.data).toBeUndefined();
    expect(result.eventType).toBe('content_block_start');
  });

  it('handles lines with no data prefix', () => {
    const lines = [': keep-alive'];
    const result = parseAnthropicSSELines(lines);
    expect(result.data).toBeUndefined();
    expect(result.eventType).toBeUndefined();
  });
});

describe('mergeAnthropicToolUseDelta', () => {
  it('creates pending entry on content_block_start', () => {
    const pending = new Map<number, AnthropicPendingToolUse>();
    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_web', input: '' },
    }, 'content_block_start');

    expect(pending.size).toBe(1);
    const entry = pending.get(0)!;
    expect(entry.name).toBe('search_web');
    expect(entry.id).toBe('toolu_1');
    expect(entry.inputRaw).toBe('');
  });

  it('accumulates partial_json across deltas', () => {
    const pending = new Map<number, AnthropicPendingToolUse>();
    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_web', input: '' },
    }, 'content_block_start');

    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q' },
    }, 'content_block_delta');

    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'uery":"cats"}' },
    }, 'content_block_delta');

    expect(pending.get(0)!.inputRaw).toBe('{"query":"cats"}');
  });

  it('handles multiple tool_use blocks at different indexes', () => {
    const pending = new Map<number, AnthropicPendingToolUse>();
    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_0', name: 'tool_a', input: '' },
    }, 'content_block_start');

    mergeAnthropicToolUseDelta(pending, {
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'tool_b', input: '' },
    }, 'content_block_start');

    expect(pending.size).toBe(2);
    expect(pending.get(0)!.name).toBe('tool_a');
    expect(pending.get(1)!.name).toBe('tool_b');
  });

  it('ignores non-tool_use content_block_start', () => {
    const pending = new Map<number, AnthropicPendingToolUse>();
    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      content_block: { type: 'text', text: '' },
    }, 'content_block_start');

    expect(pending.size).toBe(0);
  });

  it('ignores content_block_delta with non-input_json_delta type', () => {
    const pending = new Map<number, AnthropicPendingToolUse>();
    pending.set(0, { index: 0, id: 'toolu_1', name: 'test', inputRaw: '' });

    mergeAnthropicToolUseDelta(pending, {
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    }, 'content_block_delta');

    expect(pending.get(0)!.inputRaw).toBe('');
  });

  it('content_block_stop is a no-op', () => {
    const pending = new Map<number, AnthropicPendingToolUse>();
    pending.set(0, { index: 0, id: 'toolu_1', name: 'test', inputRaw: '{"x":1}' });

    mergeAnthropicToolUseDelta(pending, { index: 0 }, 'content_block_stop');

    expect(pending.get(0)!.inputRaw).toBe('{"x":1}');
  });
});

describe('finalizeAnthropicToolUse', () => {
  it('parses valid JSON input', () => {
    const tc: AnthropicPendingToolUse = { index: 0, id: 'toolu_1', name: 'search_web', inputRaw: '{"query":"cats"}' };
    const result = finalizeAnthropicToolUse(tc);
    expect(result.arguments).toEqual({ query: 'cats' });
    expect(result.name).toBe('search_web');
    expect(result.id).toBe('toolu_1');
  });

  it('returns empty args for malformed JSON', () => {
    const tc: AnthropicPendingToolUse = { index: 0, id: 'toolu_1', name: 'search_web', inputRaw: '{"unclosed' };
    const result = finalizeAnthropicToolUse(tc);
    expect(result.arguments).toEqual({});
  });

  it('returns empty args for array JSON', () => {
    const tc: AnthropicPendingToolUse = { index: 0, id: 'toolu_1', name: 'search_web', inputRaw: '[1,2,3]' };
    const result = finalizeAnthropicToolUse(tc);
    expect(result.arguments).toEqual({});
  });

  it('returns empty args for empty string', () => {
    const tc: AnthropicPendingToolUse = { index: 0, id: 'toolu_1', name: 'search_web', inputRaw: '' };
    const result = finalizeAnthropicToolUse(tc);
    expect(result.arguments).toEqual({});
  });
});

describe('synthAnthropicBlockedEvent', () => {
  it('contains the block reason in a text delta', () => {
    const output = synthAnthropicBlockedEvent('Policy violation');
    expect(output).toContain('[BLOCKED by veto]');
    expect(output).toContain('Policy violation');
  });

  it('includes all required SSE events', () => {
    const output = synthAnthropicBlockedEvent('test');
    expect(output).toContain('event: content_block_start');
    expect(output).toContain('event: content_block_delta');
    expect(output).toContain('event: content_block_stop');
    expect(output).toContain('event: message_stop');
  });

  it('emits valid JSON in each data line', () => {
    const output = synthAnthropicBlockedEvent('test');
    const dataLines = output.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines.length).toBe(4);
    for (const line of dataLines) {
      const json = JSON.parse(line.slice(6)) as Record<string, unknown>;
      expect(json).toBeDefined();
    }
  });

  it('emits a text-type content block, not tool_use', () => {
    const output = synthAnthropicBlockedEvent('test');
    const dataLines = output.split('\n').filter((l) => l.startsWith('data: '));
    const blockStart = JSON.parse(dataLines[0].slice(6)) as Record<string, unknown>;
    const contentBlock = blockStart['content_block'] as Record<string, unknown>;
    expect(contentBlock['type']).toBe('text');
  });
});
