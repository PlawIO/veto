/**
 * Kernel client for local model inference via Ollama.
 *
 * Uses the OpenAI SDK with Ollama's OpenAI-compatible API
 * to run the fine-tuned Veto model locally.
 *
 * @module kernel/client
 */

import type { Logger } from '../utils/logger.js';
import type { Rule } from '../rules/types.js';
import { createEnvTokenVault, maskVaultedResponse } from '../custom/token-vault.js';
import type {
  KernelConfig,
  KernelResponse,
  KernelToolCall,
  ResolvedKernelConfig,
} from './types.js';
import { KernelError, KernelParseError, resolveKernelConfig } from './types.js';
import { buildPrompt, buildSystemPrompt } from './prompt.js';

/**
 * Minimal OpenAI client interface for type safety without importing the full package.
 */
export interface OpenAIClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature?: number;
        max_tokens?: number;
      }): Promise<{
        choices: Array<{
          message?: {
            content?: string | null;
          };
        }>;
      }>;
    };
  };
}

/**
 * Options for creating a kernel client.
 */
export interface KernelClientOptions {
  /** Kernel configuration */
  config: KernelConfig;
  /** Logger instance */
  logger: Logger;
  /** Optional OpenAI client instance (for testing or custom clients) */
  openaiClient?: OpenAIClient;
}

/**
 * Client for running the Veto model locally via Ollama.
 */
export class KernelClient {
  private readonly config: ResolvedKernelConfig;
  private readonly logger: Logger;
  private openai: OpenAIClient | null;

  constructor(options: KernelClientOptions) {
    this.config = resolveKernelConfig(options.config);
    this.logger = options.logger;
    this.openai = options.openaiClient ?? null;

    this.logger.debug('Kernel client initialized', {
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      temperature: this.config.temperature,
    });
  }

  /**
   * Lazily initialize the OpenAI client.
   * This allows the client to be created even if openai is not installed,
   * failing only when actually used.
   */
  private async getOpenAI(): Promise<OpenAIClient> {
    if (this.openai) {
      return this.openai;
    }

    try {
      const OpenAI = (await import('openai')).default;
      this.openai = new OpenAI({
        baseURL: this.config.baseUrl,
        apiKey: 'ollama', // Ollama doesn't need a real key
      }) as unknown as OpenAIClient;
      return this.openai;
    } catch (error) {
      throw new KernelError(
        'Failed to load openai package. Install it with: npm install openai',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Evaluate a tool call against rules using the kernel model.
   *
   * @param toolCall - The tool call to evaluate
   * @param rules - Rules to evaluate against
   * @returns Kernel response with decision and weights
   */
  async evaluate(toolCall: KernelToolCall, rules: Rule[]): Promise<KernelResponse> {
    const openai = await this.getOpenAI();

    const systemPrompt = buildSystemPrompt();
    const tokenVault = createEnvTokenVault({ envVarNames: this.config.tokenVaultEnvVars });
    const userPrompt = tokenVault.redactText(buildPrompt(toolCall, rules));

    this.logger.debug('Evaluating tool call with kernel', {
      tool: toolCall.tool,
      ruleCount: rules.length,
    });

    try {
      const response = await openai.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      });

      if (!response.choices || response.choices.length === 0) {
        throw new KernelError('Empty response from kernel');
      }

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new KernelError('No content in kernel response');
      }

      return maskVaultedResponse(this.parseResponse(content), tokenVault);
    } catch (error) {
      if (error instanceof KernelError || error instanceof KernelParseError) {
        throw error;
      }

      throw new KernelError(
        `Kernel evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Parse the model response into a structured KernelResponse.
   */
  private parseResponse(content: string): KernelResponse {
    // Log the raw response for debugging
    this.logger.debug('Raw kernel model response:', { rawContent: content });

    // Extract JSON from response (model might include extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new KernelParseError('No JSON found in response', content);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new KernelParseError('Invalid JSON in response', content);
    }

    // Validate required fields
    if (!parsed || typeof parsed !== 'object') {
      throw new KernelParseError('Response is not an object', content);
    }

    const response = parsed as Record<string, unknown>;

    if (typeof response.pass_weight !== 'number') {
      throw new KernelParseError('Missing or invalid pass_weight', content);
    }
    if (typeof response.block_weight !== 'number') {
      throw new KernelParseError('Missing or invalid block_weight', content);
    }
    if (response.decision !== 'pass' && response.decision !== 'block') {
      throw new KernelParseError('Missing or invalid decision', content);
    }
    if (typeof response.reasoning !== 'string') {
      throw new KernelParseError('Missing or invalid reasoning', content);
    }

    const result: KernelResponse = {
      pass_weight: response.pass_weight,
      block_weight: response.block_weight,
      decision: response.decision,
      reasoning: response.reasoning,
    };

    if (Array.isArray(response.matched_rules)) {
      result.matched_rules = response.matched_rules.filter(
        (r): r is string => typeof r === 'string'
      );
    }

    this.logger.debug('Kernel response parsed', {
      decision: result.decision,
      passWeight: result.pass_weight,
      blockWeight: result.block_weight,
    });

    return result;
  }

  /**
   * Check if the kernel is available and the model is loaded.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const testToolCall: KernelToolCall = {
        tool: 'health_check',
        arguments: {},
      };

      await this.evaluate(testToolCall, []);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a new kernel client.
 */
export function createKernelClient(options: KernelClientOptions): KernelClient {
  return new KernelClient(options);
}
