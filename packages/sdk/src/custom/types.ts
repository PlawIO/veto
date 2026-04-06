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

/**
 * Base error class for custom provider errors.
 */
export class CustomError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'CustomError';
    this.cause = cause;
  }
}

/**
 * Error thrown when response parsing fails.
 */
export class CustomParseError extends CustomError {
  readonly rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = 'CustomParseError';
    this.rawResponse = rawResponse;
  }
}

/**
 * Error thrown when API key is missing.
 */
export class CustomAPIKeyError extends CustomError {
  readonly provider: CustomProvider;

  constructor(provider: CustomProvider, envVar: string) {
    super(
      `API key for ${provider} not found. Set ${envVar} environment variable or provide apiKey in config.`
    );
    this.name = 'CustomAPIKeyError';
    this.provider = provider;
  }
}

/**
 * Resolve custom configuration with defaults and validation.
 *
 * @param config - User-provided configuration
 * @returns Resolved configuration with all required fields
 * @throws {CustomAPIKeyError} If API key is not found
 */
export function resolveCustomConfig(config: CustomConfig): ResolvedCustomConfig {
  // Resolve API key: use provided key or environment variable
  const envVar = PROVIDER_ENV_VARS[config.provider];
  const apiKey = config.apiKey || process.env[envVar];

  if (!apiKey) {
    throw new CustomAPIKeyError(config.provider, envVar);
  }

  return {
    provider: config.provider,
    model: config.model,
    apiKey,
    temperature: config.temperature ?? CUSTOM_DEFAULTS.temperature,
    maxTokens: config.maxTokens ?? CUSTOM_DEFAULTS.maxTokens,
    timeout: config.timeout ?? CUSTOM_DEFAULTS.timeout,
    baseUrl: config.baseUrl ?? PROVIDER_BASE_URLS[config.provider],
  };
}
