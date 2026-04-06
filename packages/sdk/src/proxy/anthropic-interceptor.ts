/**
 * SSE stream interceptor for Anthropic Messages API.
 *
 * Anthropic SSE differs from OpenAI: events carry an `event:` type line
 * followed by a `data:` JSON line. Tool calls arrive as content blocks
 * (content_block_start → content_block_delta → content_block_stop) and
 * the input JSON is streamed as partial fragments across deltas.
 *
 * @module proxy/anthropic-interceptor
 */

export interface AnthropicPendingToolUse {
  index: number;
  id: string;
  name: string;
  inputRaw: string;
}

export interface AnthropicSSELineResult {
  line: string;
  eventType?: string;
  data?: Record<string, unknown> | null;
  hasToolUse?: boolean;
  toolUseStop?: boolean;
  messageStop?: boolean;
}

/**
 * Parse buffered SSE lines (an event: + data: pair) into a structured result.
 * Anthropic sends `event: <type>\ndata: <json>` pairs.
 */
export function parseAnthropicSSELines(lines: string[]): AnthropicSSELineResult {
  let eventType: string | undefined;
  let dataStr: string | undefined;
  const raw = lines.join('\n');

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataStr = line.slice(6);
    }
  }

  if (!dataStr) {
    return { line: raw, eventType };
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    return { line: raw, eventType };
  }

  let hasToolUse = false;
  let toolUseStop = false;
  const messageStop = eventType === 'message_stop';

  if (eventType === 'content_block_start') {
    const block = data['content_block'] as Record<string, unknown> | undefined;
    if (block && block['type'] === 'tool_use') {
      hasToolUse = true;
    }
  } else if (eventType === 'content_block_delta') {
    const delta = data['delta'] as Record<string, unknown> | undefined;
    if (delta && delta['type'] === 'input_json_delta') {
      hasToolUse = true;
    }
  } else if (eventType === 'content_block_stop') {
    toolUseStop = true;
  }

  return { line: raw, eventType, data, hasToolUse, toolUseStop, messageStop };
}

/**
 * Merge tool use data from Anthropic SSE events into the pending map.
 *
 * - content_block_start with type=tool_use: create a new pending entry
 * - content_block_delta with type=input_json_delta: append partial_json
 * - content_block_stop: no-op (signals block completion)
 */
export function mergeAnthropicToolUseDelta(
  pending: Map<number, AnthropicPendingToolUse>,
  data: Record<string, unknown>,
  eventType: string,
): void {
  const index = typeof data['index'] === 'number' ? data['index'] : 0;

  if (eventType === 'content_block_start') {
    const block = data['content_block'] as Record<string, unknown> | undefined;
    if (!block || block['type'] !== 'tool_use') return;
    pending.set(index, {
      index,
      id: typeof block['id'] === 'string' ? block['id'] : '',
      name: typeof block['name'] === 'string' ? block['name'] : '',
      inputRaw: '',
    });
  } else if (eventType === 'content_block_delta') {
    const delta = data['delta'] as Record<string, unknown> | undefined;
    if (!delta || delta['type'] !== 'input_json_delta') return;
    const existing = pending.get(index);
    if (existing && typeof delta['partial_json'] === 'string') {
      existing.inputRaw += delta['partial_json'] as string;
    }
  }
  // content_block_stop: nothing to accumulate
}

/**
 * Parse the accumulated input JSON into an arguments object.
 */
export function finalizeAnthropicToolUse(tc: AnthropicPendingToolUse): {
  name: string;
  id: string;
  arguments: Record<string, unknown>;
} {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(tc.inputRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    console.warn(`[veto intercept] Malformed tool input for '${tc.name}', validating with empty args`);
  }
  return { name: tc.name, id: tc.id, arguments: args };
}

/**
 * Synthesize Anthropic SSE events that replace a tool_use block with a
 * text block containing the block reason, followed by message_stop.
 */
export function synthAnthropicBlockedEvent(reason: string): string {
  const blockStart = {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  };
  const blockDelta = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: `[BLOCKED by veto] ${reason}` },
  };
  const blockStop = {
    type: 'content_block_stop',
    index: 0,
  };

  return [
    `event: content_block_start\ndata: ${JSON.stringify(blockStart)}`,
    `event: content_block_delta\ndata: ${JSON.stringify(blockDelta)}`,
    `event: content_block_stop\ndata: ${JSON.stringify(blockStop)}`,
    `event: message_stop\ndata: {}`,
  ]
    .map((s) => s + '\n\n')
    .join('');
}
