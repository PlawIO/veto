import { afterEach, describe, expect, it, vi } from 'vitest';
import { VetoAdmin, VetoAdminError } from '../../src/admin/client.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    ...init,
  });
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

describe('VetoAdmin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires an API key', () => {
    expect(() => new VetoAdmin({ apiKey: '' })).toThrow('VetoAdmin requires an apiKey');
  });

  it('builds GET requests with query params and auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [{ id: 'pol_1', toolName: 'send_email' }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({
      apiKey: 'vk_test',
      baseUrl: 'https://self-hosted.veto.local/',
    });

    const result = await admin.listPolicies({ projectId: 'proj_123' });

    expect(result).toEqual([{ id: 'pol_1', toolName: 'send_email' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://self-hosted.veto.local/v1/policies?projectId=proj_123',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Veto-API-Key': 'vk_test',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('sends POST bodies for mutating requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'pol_2',
        toolName: 'transfer_funds',
        action: 'deny',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({ apiKey: 'vk_test', baseUrl: 'https://api.example.com' });
    const payload = {
      toolName: 'transfer_funds',
      projectId: 'proj_123',
      rules: [{ id: 'block-large', action: 'block' }],
    };

    await admin.createPolicy(payload as any);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/policies',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    );
  });

  it('surfaces failed requests as VetoAdminError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      textResponse('policy not found', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({ apiKey: 'vk_test', baseUrl: 'https://api.example.com' });

    await expect(admin.getPolicy('missing_tool')).rejects.toMatchObject({
      name: 'VetoAdminError',
      statusCode: 404,
      message: 'GET /policies/missing_tool failed (404): policy not found',
    });
  });

  it('returns text bodies for export endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse('rules:\n  - id: export-1\n'));
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({ apiKey: 'vk_test', baseUrl: 'https://api.example.com' });
    const result = await admin.exportPolicies({ projectId: 'proj_123', format: 'yaml' });

    expect(result).toContain('export-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/policies/export?projectId=proj_123&format=yaml',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('parses SSE events for onEvent subscriptions and ignores malformed payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"deny","id":"evt_1"}\n',
        '\n',
        'data: :ping\n',
        '\n',
        'data: not-json\n',
        '\n',
        'data: {"type":"allow","id":"evt_2"}\n',
        '\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({ apiKey: 'vk_test', baseUrl: 'https://api.example.com' });
    const events: Array<Record<string, unknown>> = [];

    const receivedTwoEvents = new Promise<void>((resolve) => {
      admin.onEvent(['deny', 'allow'], (event) => {
        events.push(event as Record<string, unknown>);
        if (events.length === 2) {
          resolve();
        }
      });
    });

    await receivedTwoEvents;

    expect(events).toEqual([
      { type: 'deny', id: 'evt_1' },
      { type: 'allow', id: 'evt_2' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/events/stream?types=deny%2Callow',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          'X-Veto-API-Key': 'vk_test',
        }),
      }),
    );
  });

  it('yields parsed SSE events from subscribeEvents()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"type":"require_approval","id":"evt_3"}\n',
        '\n',
        'data: {"type":"deny","id":"evt_4"}\n',
        '\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({ apiKey: 'vk_test', baseUrl: 'https://api.example.com' });
    const events: Array<Record<string, unknown>> = [];

    for await (const event of admin.subscribeEvents({ types: ['require_approval', 'deny'] })) {
      events.push(event as Record<string, unknown>);
    }

    expect(events).toEqual([
      { type: 'require_approval', id: 'evt_3' },
      { type: 'deny', id: 'evt_4' },
    ]);
  });

  it('converts aborted fetches into timeout errors', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const admin = new VetoAdmin({
      apiKey: 'vk_test',
      baseUrl: 'https://api.example.com',
      timeout: 5,
    });

    await expect(admin.listTools()).rejects.toEqual(
      new VetoAdminError('Request timed out after 5ms', 0),
    );
  });
});
