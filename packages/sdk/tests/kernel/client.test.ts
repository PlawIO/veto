import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KernelClient, createKernelClient, type OpenAIClient } from '../../src/kernel/client.js';
import type { KernelConfig } from '../../src/kernel/types.js';
import { KernelError, KernelParseError } from '../../src/kernel/types.js';
import type { Rule } from '../../src/rules/types.js';
import { createLogger } from '../../src/utils/logger.js';

const ORIGINAL_ENV = { ...process.env };

/**
 * Create a mock OpenAI client for testing.
 */
function createMockOpenAI(mockCreate: ReturnType<typeof vi.fn>): OpenAIClient {
  return {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  };
}

describe('KernelClient', () => {
  const logger = createLogger('silent');
  
  const config: KernelConfig = {
    baseUrl: 'http://localhost:11434/v1',
    model: 'veto-warden:latest',
  };

  const sampleToolCall = {
    tool: 'execute_command',
    arguments: { command: 'rm -rf /' },
  };

  const sampleRules: Rule[] = [
    {
      id: 'block-rm',
      name: 'Block rm -rf',
      enabled: true,
      severity: 'critical',
      action: 'block',
      tools: ['execute_command'],
      conditions: [
        { field: 'arguments.command', operator: 'contains', value: 'rm -rf' },
      ],
    },
  ];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('createKernelClient', () => {
    it('should create a client with config', () => {
      const client = createKernelClient({ config, logger });
      expect(client).toBeInstanceOf(KernelClient);
    });

    it('should apply default config values', () => {
      const client = createKernelClient({ config, logger });
      expect(client).toBeInstanceOf(KernelClient);
    });
  });

  describe('evaluate', () => {
    it('should return block decision when model blocks', async () => {
      const mockResponse = {
        pass_weight: 0.02,
        block_weight: 0.98,
        decision: 'block',
        reasoning: 'Destructive command detected',
        matched_rules: ['block-rm'],
      };

      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      const result = await client.evaluate(sampleToolCall, sampleRules);

      expect(result.decision).toBe('block');
      expect(result.block_weight).toBeGreaterThan(0.9);
      expect(result.reasoning).toContain('Destructive');
      expect(result.matched_rules).toContain('block-rm');
    });

    it('should return pass decision when model passes', async () => {
      const safeToolCall = {
        tool: 'read_file',
        arguments: { path: '/home/user/file.txt' },
      };

      const mockResponse = {
        pass_weight: 0.95,
        block_weight: 0.05,
        decision: 'pass',
        reasoning: 'Safe file access',
      };

      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      const result = await client.evaluate(safeToolCall, sampleRules);

      expect(result.decision).toBe('pass');
      expect(result.pass_weight).toBeGreaterThan(0.9);
    });

    it('should parse JSON from response with extra text', async () => {
      const mockResponse = {
        pass_weight: 0.1,
        block_weight: 0.9,
        decision: 'block',
        reasoning: 'Blocked',
      };

      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ 
          message: { 
            content: `Here is my analysis:\n${JSON.stringify(mockResponse)}\nEnd of response.` 
          } 
        }],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      const result = await client.evaluate(sampleToolCall, sampleRules);

      expect(result.decision).toBe('block');
    });

    it('should throw KernelParseError when response has no JSON', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'I cannot evaluate this request.' } }],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });

      await expect(client.evaluate(sampleToolCall, sampleRules))
        .rejects.toThrow(KernelParseError);
    });

    it('should throw KernelParseError when JSON is invalid', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"pass_weight": "not a number"}' } }],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });

      await expect(client.evaluate(sampleToolCall, sampleRules))
        .rejects.toThrow(KernelParseError);
    });

    it('should throw KernelError when API call fails', async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });

      await expect(client.evaluate(sampleToolCall, sampleRules))
        .rejects.toThrow(KernelError);
    });

    it('should throw KernelError when response is empty', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });

      await expect(client.evaluate(sampleToolCall, sampleRules))
        .rejects.toThrow(KernelError);
    });

    it('should use correct model and temperature from config', async () => {
      const customConfig: KernelConfig = {
        baseUrl: 'http://custom:11434/v1',
        model: 'custom-model:v2',
        temperature: 0.5,
        maxTokens: 512,
      };

      const mockResponse = {
        pass_weight: 0.5,
        block_weight: 0.5,
        decision: 'pass',
        reasoning: 'OK',
      };

      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      const client = createKernelClient({
        config: customConfig,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      await client.evaluate(sampleToolCall, sampleRules);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'custom-model:v2',
          temperature: 0.5,
          max_tokens: 512,
        })
      );
    });

    it('redacts env var secrets before kernel requests and masks placeholder responses', async () => {
      process.env.STRIPE_API_KEY = 'sk_live_kernel_secret';
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              pass_weight: 0.1,
              block_weight: 0.9,
              decision: 'block',
              reasoning: 'Secret __VETO_TOKEN_VAULT_1__ is blocked',
            }),
          },
        }],
      });

      const client = createKernelClient({
        config: { ...config, tokenVaultEnvVars: ['STRIPE_API_KEY'] },
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      const result = await client.evaluate(
        { tool: 'charge_card', arguments: { apiKey: 'sk_live_kernel_secret' } },
        sampleRules
      );

      const request = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
      const userPrompt = request.messages[1].content;
      expect(userPrompt).toContain('__VETO_TOKEN_VAULT_1__');
      expect(userPrompt).not.toContain('STRIPE_API_KEY');
      expect(userPrompt).not.toContain('sk_live_kernel_secret');
      expect(result.reasoning).toBe('Secret [REDACTED_ENV:STRIPE_API_KEY] is blocked');
      expect(result.reasoning).not.toContain('sk_live_kernel_secret');
    });
  });

  describe('healthCheck', () => {
    it('should return true when model is available', async () => {
      const mockResponse = {
        pass_weight: 1,
        block_weight: 0,
        decision: 'pass',
        reasoning: 'Health check',
      };

      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      const healthy = await client.healthCheck();

      expect(healthy).toBe(true);
    });

    it('should return false when model is unavailable', async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error('Model not found'));

      const client = createKernelClient({
        config,
        logger,
        openaiClient: createMockOpenAI(mockCreate),
      });
      const healthy = await client.healthCheck();

      expect(healthy).toBe(false);
    });
  });
});
