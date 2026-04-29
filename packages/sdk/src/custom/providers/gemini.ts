/**
 * Google Gemini provider adapter for custom validation.
 *
 * @module custom/providers/gemini
 */

import type { Logger } from '../../utils/logger.js';
import type { ResolvedCustomConfig } from '../types.js';
import type { ProviderMessages } from '../prompt.js';
import { CustomError } from '../types.js';

async function loadOptionalModule<T>(moduleName: string): Promise<T> {
  return await import(moduleName) as T;
}

/**
 * Schema for Veto validation response.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    pass_weight: { type: 'number', description: 'Weight for pass decision (0-1)' },
    block_weight: { type: 'number', description: 'Weight for block decision (0-1)' },
    decision: { type: 'string', enum: ['pass', 'block'], description: 'The validation decision' },
    reasoning: { type: 'string', description: 'Brief explanation of the decision' },
  },
  required: ['pass_weight', 'block_weight', 'decision', 'reasoning'],
};

/**
 * Call Google Gemini API with the given prompt.
 *
 * @param messages - Provider-specific message structure
 * @param config - Resolved custom configuration
 * @param logger - Logger instance
 * @returns Raw text response from Gemini
 */
export async function callGemini(
  messages: ProviderMessages,
  config: ResolvedCustomConfig,
  logger: Logger
): Promise<string> {
  try {
    const { GoogleGenAI } = await loadOptionalModule<{
      GoogleGenAI: new (options: { apiKey: string }) => {
        models: {
          generateContent(args: Record<string, unknown>): Promise<{ text?: string }>;
        };
      };
    }>('@google/genai');
    const ai = new GoogleGenAI({ apiKey: config.apiKey });

    // Extract text from Gemini content format
    const textContent = messages.contents?.[0]?.parts?.[0]?.text ?? '';

    logger.debug('Calling Gemini API', {
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });

    const response = await ai.models.generateContent({
      model: config.model,
      contents: textContent,
      config: {
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) {
      throw new CustomError('Empty response from Gemini');
    }

    return text;
  } catch (error) {
    if (error instanceof CustomError) {
      throw error;
    }

    throw new CustomError(
      `Gemini API call failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}
