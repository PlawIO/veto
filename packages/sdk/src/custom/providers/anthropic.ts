import type { Logger } from '../../utils/logger.js';
import type { ResolvedCustomConfig } from '../types.js';
import type { ProviderMessages } from '../prompt.js';
import { CustomError, CustomProviderPackageError } from '../types.js';
import { withProviderRetry } from './utils.js';

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content: AnthropicTextBlock[];
}

interface AnthropicClient {
  messages: {
    create(
      body: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<AnthropicMessageResponse>;
  };
}

type AnthropicConstructor = new (options: {
  apiKey: string;
  timeout?: number;
  maxRetries?: number;
}) => AnthropicClient;

async function loadOptionalModule<T>(moduleName: string): Promise<T> {
  return await import(moduleName) as T;
}

async function loadAnthropic(): Promise<AnthropicConstructor> {
  try {
    const module = await loadOptionalModule<{ default: AnthropicConstructor }>('@anthropic-ai/sdk');
    return module.default;
  } catch (error) {
    throw new CustomProviderPackageError(
      'anthropic',
      '@anthropic-ai/sdk',
      error instanceof Error ? error : undefined
    );
  }
}

export async function callAnthropic(
  messages: ProviderMessages,
  config: ResolvedCustomConfig,
  logger: Logger
): Promise<string> {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeout,
    maxRetries: 0,
  });

  logger.debug('Calling Anthropic API', {
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: config.timeout,
  });

  const response = await withProviderRetry(
    () => client.messages.create(
      {
        model: config.model,
        system: messages.system,
        messages: messages.messages ?? [],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      },
      {
        timeout: config.timeout,
        maxRetries: 0,
      }
    ),
    {
      providerLabel: 'Anthropic',
      timeoutMs: config.timeout,
      logger,
    }
  );

  const content = response.content[0];
  if (!content || content.type !== 'text' || typeof content.text !== 'string') {
    throw new CustomError('Unexpected response type from Anthropic');
  }

  return content.text;
}
