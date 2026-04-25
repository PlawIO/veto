import type { Logger } from '../../utils/logger.js';
import type { ResolvedCustomConfig } from '../types.js';
import type { ProviderMessages } from '../prompt.js';
import { CustomError, CustomProviderPackageError } from '../types.js';
import { withProviderRetry } from './utils.js';

interface OpenAIChatCompletionResponse {
  choices: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface OpenAIClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: Record<string, unknown>
      ): Promise<OpenAIChatCompletionResponse>;
    };
  };
}

type OpenAIConstructor = new (options: {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
}) => OpenAIClient;

async function loadOpenAI(): Promise<OpenAIConstructor> {
  try {
    const module = await import('openai') as unknown as { default: OpenAIConstructor };
    return module.default;
  } catch (error) {
    throw new CustomProviderPackageError(
      'openai',
      'openai',
      error instanceof Error ? error : undefined
    );
  }
}

export async function callOpenAI(
  messages: ProviderMessages,
  config: ResolvedCustomConfig,
  logger: Logger
): Promise<string> {
  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.timeout,
    maxRetries: 0,
  });

  logger.debug('Calling OpenAI API', {
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeout: config.timeout,
  });

  const response = await withProviderRetry(
    () => client.chat.completions.create(
      {
        model: config.model,
        messages: messages.messages ?? [],
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        response_format: { type: 'json_object' },
      },
      {
        timeout: config.timeout,
        maxRetries: 0,
      }
    ),
    {
      providerLabel: 'OpenAI',
      timeoutMs: config.timeout,
      logger,
    }
  );

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new CustomError('Empty response from OpenAI');
  }

  return content;
}
