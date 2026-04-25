import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/utils/logger.js';
import type { ProviderMessages } from '../../src/custom/prompt.js';
import type { ResolvedCustomConfig } from '../../src/custom/types.js';
import { callOpenAI } from '../../src/custom/providers/openai.js';

const openAiMock = vi.hoisted(() => ({
  create: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock(options: Record<string, unknown>) {
    openAiMock.constructorOptions.push(options);
    return {
      chat: {
        completions: {
          create: openAiMock.create,
        },
      },
    };
  }),
}));

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const messages: ProviderMessages = {
  messages: [{ role: 'user', content: 'validate this call' }],
};

const config: ResolvedCustomConfig = {
  provider: 'openai',
  model: 'gpt-test',
  apiKey: 'sk-test',
  temperature: 0.1,
  maxTokens: 123,
  timeout: 1234,
  baseUrl: 'https://api.openai.com/v1',
};

function successResponse(content = '{"decision":"pass"}'): unknown {
  return {
    choices: [
      {
        message: {
          content,
        },
      },
    ],
  };
}

describe('OpenAI custom provider', () => {
  afterEach(() => {
    vi.clearAllMocks();
    openAiMock.constructorOptions.length = 0;
  });

  it('passes timeout and disables SDK retries', async () => {
    openAiMock.create.mockResolvedValueOnce(successResponse());

    await callOpenAI(messages, config, logger);

    expect(openAiMock.constructorOptions[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      timeout: 1234,
      maxRetries: 0,
    });
    expect(openAiMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-test' }),
      expect.objectContaining({ timeout: 1234, maxRetries: 0 })
    );
  });

  it('retries 429 failures', async () => {
    openAiMock.create
      .mockRejectedValueOnce({ status: 429, message: 'rate limited' })
      .mockResolvedValueOnce(successResponse());

    const content = await callOpenAI(messages, config, logger);

    expect(content).toBe('{"decision":"pass"}');
    expect(openAiMock.create).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'OpenAI request failed, retrying',
      expect.objectContaining({ status: 429 })
    );
  });

  it('retries transient network failures', async () => {
    openAiMock.create
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(successResponse());

    await callOpenAI(messages, config, logger);

    expect(openAiMock.create).toHaveBeenCalledTimes(2);
  });

  it('does not retry 401 failures', async () => {
    openAiMock.create.mockRejectedValueOnce({ status: 401, message: 'unauthorized' });

    await expect(callOpenAI(messages, config, logger)).rejects.toThrow(/authentication failed with status 401/);
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
  });
});
