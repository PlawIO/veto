/**
 * Custom LLM provider types for validation.
 *
 * @module custom/types
 */

/**
 * Supported LLM providers for custom validation mode.
 */
export type CustomProvider = 'gemini' | 'openrouter' | 'openai' | 'anthropic';

/**
 * Configuration for custom validation mode.
 */
export interface CustomConfig {
  /** LLM provider to use */
  provider: CustomProvider;
  /** Model identifier (e.g., 'gpt-5.4', 'claude-3-5-sonnet-20241022') */
  model: string;
  /** API key for authentication (or env var name) */
  apiKey?: string;
  /** Temperature for inference (default: 0.1) */
  temperature?: number;
  /** Maximum tokens for response (default: 500) */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Base URL override (for OpenRouter, custom endpoints) */
  baseUrl?: string;
}

/**
 * Resolved custom configuration with defaults.
 */
export interface ResolvedCustomConfig {
  provider: CustomProvider;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  baseUrl?: string;
}

/**
 * Response from custom LLM provider (matches kernel format).
 */
export interface CustomResponse {
  pass_weight: number;
  block_weight: number;
  decision: 'pass' | 'block';
  reasoning: string;
  matched_rules?: string[];
}

/**
 * Tool call structure for custom validation (matches kernel).
 */
export interface CustomToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * Environment variable names for each provider.
 */
export const PROVIDER_ENV_VARS: Record<CustomProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/**
 * Default base URLs for each provider.
 */
export const PROVIDER_BASE_URLS: Record<CustomProvider, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  anthropic: undefined, // Uses SDK default
  gemini: undefined, // Uses SDK default
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Default values for custom configuration.
 */
export const CUSTOM_DEFAULTS = {
  temperature: 0.1,
  maxTokens: 500,
  timeout: 30000,
} as const;

export class CustomError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'CustomError';
    this.cause = cause;
  }
}

export class CustomConfigError extends CustomError {
  constructor(message: string) {
    super(message);
    this.name = 'CustomConfigError';
  }
}

export class CustomParseError extends CustomError {
  readonly rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = 'CustomParseError';
    this.rawResponse = rawResponse;
  }
}

export class CustomAPIKeyError extends CustomConfigError {
  readonly provider: CustomProvider;
  readonly envVar: string;

  constructor(provider: CustomProvider, envVar: string, configuredEnvVar = false) {
    const message = configuredEnvVar
      ? `API key env var ${envVar} for custom provider ${provider} is not set or empty. Set ${envVar} or configure custom.apiKey with a literal secret.`
      : `Missing API key for custom provider ${provider}. Set ${envVar} environment variable or configure custom.apiKey.`;
    super(message);
    this.name = 'CustomAPIKeyError';
    this.provider = provider;
    this.envVar = envVar;
  }
}

export class CustomProviderPackageError extends CustomError {
  readonly provider: CustomProvider;
  readonly packageName: string;

  constructor(provider: CustomProvider, packageName: string, cause?: Error) {
    super(
      `Custom provider package "${packageName}" is not installed. Install ${packageName} to use custom.provider="${provider}".`,
      cause
    );
    this.name = 'CustomProviderPackageError';
    this.provider = provider;
    this.packageName = packageName;
  }
}

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SUPPORTED_PROVIDERS = new Set<CustomProvider>([
  'gemini',
  'openrouter',
  'openai',
  'anthropic',
]);

function isSupportedProvider(provider: unknown): provider is CustomProvider {
  return typeof provider === 'string' && SUPPORTED_PROVIDERS.has(provider as CustomProvider);
}

function looksLikeEnvVarName(value: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(value);
}

function resolveApiKey(provider: CustomProvider, configuredApiKey?: string): string {
  const trimmedApiKey = configuredApiKey?.trim();

  if (trimmedApiKey) {
    if (looksLikeEnvVarName(trimmedApiKey)) {
      const resolvedApiKey = process.env[trimmedApiKey];
      if (!resolvedApiKey) {
        throw new CustomAPIKeyError(provider, trimmedApiKey, true);
      }
      return resolvedApiKey;
    }

    return configuredApiKey ?? trimmedApiKey;
  }

  const envVar = PROVIDER_ENV_VARS[provider];
  const apiKey = process.env[envVar];
  if (!apiKey) {
    throw new CustomAPIKeyError(provider, envVar);
  }

  return apiKey;
}

export function resolveCustomConfig(config: CustomConfig): ResolvedCustomConfig {
  const provider = (config as Partial<CustomConfig>).provider;
  if (!provider) {
    throw new CustomConfigError(
      'Missing custom.provider for custom validation. Set custom.provider to one of: openai, anthropic, gemini, openrouter.'
    );
  }

  if (!isSupportedProvider(provider)) {
    throw new CustomConfigError(
      `Unsupported custom.provider "${String(provider)}". Supported providers: openai, anthropic, gemini, openrouter.`
    );
  }

  const model = (config as Partial<CustomConfig>).model;
  if (!model || model.trim() === '') {
    throw new CustomConfigError(
      `Missing custom.model for custom provider ${provider}. Set custom.model in veto.config.yaml.`
    );
  }

  return {
    provider,
    model,
    apiKey: resolveApiKey(provider, config.apiKey),
    temperature: config.temperature ?? CUSTOM_DEFAULTS.temperature,
    maxTokens: config.maxTokens ?? CUSTOM_DEFAULTS.maxTokens,
    timeout: config.timeout ?? CUSTOM_DEFAULTS.timeout,
    baseUrl: config.baseUrl ?? PROVIDER_BASE_URLS[provider],
  };
}
