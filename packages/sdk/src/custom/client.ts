/**
 * Custom LLM provider client for validation.
 *
 * @module custom/client
 */

import type { Logger } from '../utils/logger.js';
import type { Rule } from '../rules/types.js';
import type {
  CustomConfig,
  CustomResponse,
  CustomToolCall,
  ResolvedCustomConfig,
} from './types.js';
import { CustomError, CustomParseError, resolveCustomConfig } from './types.js';
import { buildUserPrompt, buildProviderMessages } from './prompt.js';
import { createEnvTokenVault, maskVaultedResponse } from './token-vault.js';
import { callOpenAI } from './providers/openai.js';
import { callAnthropic } from './providers/anthropic.js';
import { callGemini } from './providers/gemini.js';
import { callOpenRouter } from './providers/openrouter.js';

/**
 * Options for creating a custom client.
 */
export interface CustomClientOptions {
  /** Custom provider configuration */
  config: CustomConfig;
  /** Logger instance */
  logger: Logger;
}

/**
 * Client for custom LLM provider validation.
 */
export class CustomClient {
  private readonly config: ResolvedCustomConfig;
  private readonly logger: Logger;

  constructor(options: CustomClientOptions) {
    this.config = resolveCustomConfig(options.config);
    this.logger = options.logger;

    this.logger.debug('Custom client initialized', {
      provider: this.config.provider,
      model: this.config.model,
      temperature: this.config.temperature,
    });
  }

  /**
   * Evaluate a tool call against rules using the custom LLM provider.
   *
   * @param toolCall - The tool call to evaluate
   * @param rules - Rules to evaluate against
   * @returns Custom response with decision and weights
   */
  async evaluate(toolCall: CustomToolCall, rules: Rule[]): Promise<CustomResponse> {
    const tokenVault = createEnvTokenVault({ envVarNames: this.config.tokenVaultEnvVars });
    const userPrompt = tokenVault.redactText(buildUserPrompt(toolCall, rules));
    const messages = buildProviderMessages(this.config.provider, userPrompt);

    this.logger.debug('Evaluating tool call with custom provider', {
      provider: this.config.provider,
      tool: toolCall.tool,
      ruleCount: rules.length,
    });

    try {
      // Route to appropriate provider
      const content = await this.callProvider(messages);
      return maskVaultedResponse(this.parseResponse(content), tokenVault);
    } catch (error) {
      if (error instanceof CustomError || error instanceof CustomParseError) {
        throw error;
      }

      throw new CustomError(
        `Custom validation failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Call the appropriate provider based on configuration.
   *
   * @param messages - Provider-specific message structure
   * @returns Raw text response from provider
   */
  private async callProvider(messages: any): Promise<string> {
    switch (this.config.provider) {
      case 'openai':
        return callOpenAI(messages, this.config, this.logger);
      case 'anthropic':
        return callAnthropic(messages, this.config, this.logger);
      case 'gemini':
        return callGemini(messages, this.config, this.logger);
      case 'openrouter':
        return callOpenRouter(messages, this.config, this.logger);
      default:
        throw new CustomError(`Unsupported provider: ${this.config.provider}`);
    }
  }

  /**
   * Parse LLM response into structured format.
   *
   * @param content - Raw response from LLM
   * @returns Parsed custom response
   */
  private parseResponse(content: string): CustomResponse {
    this.logger.debug('Raw custom provider response:', { rawContent: content });

    // Extract JSON from response (model might include extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new CustomParseError('No JSON found in response', content);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new CustomParseError('Invalid JSON in response', content);
    }

    // Validate required fields
    if (!parsed || typeof parsed !== 'object') {
      throw new CustomParseError('Response is not an object', content);
    }

    const response = parsed as Record<string, unknown>;

    if (typeof response.pass_weight !== 'number') {
      throw new CustomParseError('Missing or invalid pass_weight', content);
    }
    if (typeof response.block_weight !== 'number') {
      throw new CustomParseError('Missing or invalid block_weight', content);
    }
    if (response.decision !== 'pass' && response.decision !== 'block') {
      throw new CustomParseError('Missing or invalid decision', content);
    }
    if (typeof response.reasoning !== 'string') {
      throw new CustomParseError('Missing or invalid reasoning', content);
    }

    const result: CustomResponse = {
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

    this.logger.debug('Custom response parsed', {
      decision: result.decision,
      passWeight: result.pass_weight,
      blockWeight: result.block_weight,
    });

    return result;
  }

  /**
   * Check if the custom provider is available and working.
   *
   * @returns True if health check passes
   */
  async healthCheck(): Promise<boolean> {
    try {
      const testToolCall: CustomToolCall = {
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
 * Create a new custom client.
 *
 * @param options - Client options
 * @returns New custom client instance
 */
export function createCustomClient(options: CustomClientOptions): CustomClient {
  return new CustomClient(options);
}
