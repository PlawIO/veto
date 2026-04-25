import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/utils/logger.js';
import type { ProviderMessages } from '../../src/custom/prompt.js';
import type { ResolvedCustomConfig } from '../../src/custom/types.js';

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
  maxTokens: 100,
  timeout: 1000,
};

describe('custom provider package errors', () => {
  afterEach(() => {
    vi.doUnmock('openai');
    vi.resetModules();
  });

  it('classifies missing OpenAI package errors', async () => {
    vi.resetModules();
    vi.doMock('openai', () => {
      throw new Error('Cannot find package openai');
    });

    const { callOpenAI } = await import('../../src/custom/providers/openai.js');

    await expect(callOpenAI(messages, config, logger)).rejects.toThrow(
      /Custom provider package "openai" is not installed/
    );
  });
});
