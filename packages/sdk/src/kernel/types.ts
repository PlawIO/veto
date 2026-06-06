/**
 * Type definitions for the Veto kernel - local model inference.
 *
 * The kernel runs the fine-tuned Veto model locally via Ollama's
 * OpenAI-compatible API for tool call validation.
 *
 * @module kernel/types
 */

/**
 * Configuration for the Veto kernel.
 */
export interface KernelConfig {
  /** Base URL for the Ollama API (default: http://localhost:11434/v1) */
  baseUrl: string;
  /** Model identifier (e.g., hf.co/ycaleb/veto-warden-4b-GGUF:Q4_K_M) */
  model: string;
  /** Temperature for inference (default: 0.1) */
  temperature?: number;
  /** Maximum tokens for response (default: 256) */
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Additional env vars whose values are replaced with placeholders before kernel LLM calls */
  tokenVaultEnvVars?: string[];
}

/**
 * Resolved kernel configuration with defaults applied.
 */
export interface ResolvedKernelConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  tokenVaultEnvVars?: string[];
}

/**
 * Tool call structure for kernel input.
 */
export interface KernelToolCall {
  /** Tool name */
  tool: string;
  /** Tool arguments */
  arguments: Record<string, unknown>;
}

/**
 * Response from the kernel model.
 */
export interface KernelResponse {
  /** Weight indicating confidence that the call should pass (0.0 - 1.0) */
  pass_weight: number;
  /** Weight indicating confidence that the call should be blocked (0.0 - 1.0) */
  block_weight: number;
  /** Final decision */
  decision: 'pass' | 'block';
  /** Human-readable reasoning for the decision */
  reasoning: string;
  /** IDs of rules that matched (only present on block decisions) */
  matched_rules?: string[];
}

/**
 * Error thrown when kernel inference fails.
 */
export class KernelError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'KernelError';
    this.cause = cause;
  }
}

/**
 * Error thrown when kernel response cannot be parsed.
 */
export class KernelParseError extends KernelError {
  readonly rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = 'KernelParseError';
    this.rawResponse = rawResponse;
  }
}

/**
 * Default kernel configuration values.
 */
export const KERNEL_DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  temperature: 0.1,
  maxTokens: 256,
  timeout: 30000,
} as const;

/**
 * Resolve kernel configuration with defaults.
 */
export function resolveKernelConfig(config: KernelConfig): ResolvedKernelConfig {
  return {
    baseUrl: config.baseUrl.replace(/\/$/, ''), // Remove trailing slash
    model: config.model,
    temperature: config.temperature ?? KERNEL_DEFAULTS.temperature,
    maxTokens: config.maxTokens ?? KERNEL_DEFAULTS.maxTokens,
    timeout: config.timeout ?? KERNEL_DEFAULTS.timeout,
    tokenVaultEnvVars: Array.isArray(config.tokenVaultEnvVars) ? config.tokenVaultEnvVars : undefined,
  };
}
