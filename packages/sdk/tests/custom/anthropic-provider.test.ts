import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/utils/logger.js';
import type { ProviderMessages } from '../../src/custom/prompt.js';
import type { ResolvedCustomConfig } from '../../src/custom/types.js';
import { callAnthropic } from '../../src/custom/providers/anthropic.js';

const anthropicMock = vi.hoisted(() => ({
  create: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function AnthropicMock(options: Record<string, unknown>) {
    anthropicMock.constructorOptions.push(options);
    return {
      messages: {
        create: anthropicMock.create,
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
  system: 'system prompt',
  messages: [{ role: 'user', content: 'validate this call' }],
};

const config: ResolvedCustomConfig = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'sk-ant-test',
  temperature: 0.1,
  maxTokens: 123,
  timeout: 2345,
};

function successResponse(content = '{"decision":"pass"}'): unknown {
  return {
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
  };
}

describe('Anthropic custom provider', () => {
  afterEach(() => {
    vi.clearAllMocks();
    anthropicMock.constructorOptions.length = 0;
  });

  it('passes timeout and disables SDK retries', async () => {
    anthropicMock.create.mockResolvedValueOnce(successResponse());

    await callAnthropic(messages, config, logger);

    expect(anthropicMock.constructorOptions[0]).toMatchObject({
      apiKey: 'sk-ant-test',
      timeout: 2345,
      maxRetries: 0,
    });
    expect(anthropicMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-test' }),
      expect.objectContaining({ timeout: 2345, maxRetries: 0 })
    );
  });

  it('retries 5xx failures', async () => {
    anthropicMock.create
      .mockRejectedValueOnce({ status: 503, message: 'unavailable' })
      .mockResolvedValueOnce(successResponse());

    const content = await callAnthropic(messages, config, logger);

    expect(content).toBe('{"decision":"pass"}');
    expect(anthropicMock.create).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Anthropic request failed, retrying',
      expect.objectContaining({ status: 503 })
    );
  });

  it('does not retry 401 failures', async () => {
    anthropicMock.create.mockRejectedValueOnce({ status: 401, message: 'unauthorized' });

    await expect(callAnthropic(messages, config, logger)).rejects.toThrow(/authentication failed with status 401/);
    expect(anthropicMock.create).toHaveBeenCalledTimes(1);
  });
});
