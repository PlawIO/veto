import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CustomConfig,
  resolveCustomConfig,
} from '../../src/custom/types.js';

const ORIGINAL_ENV = { ...process.env };

function resetProviderEnv(): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

describe('custom provider config resolution', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetProviderEnv();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('resolves configured env var names to their secret values', () => {
    process.env.OPENAI_API_KEY = 'sk-test-secret';

    const resolved = resolveCustomConfig({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'OPENAI_API_KEY',
    });

    expect(resolved.apiKey).toBe('sk-test-secret');
  });

  it('uses the provider default env var when apiKey is absent', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-secret';

    const resolved = resolveCustomConfig({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    expect(resolved.apiKey).toBe('sk-ant-test-secret');
  });

  it('keeps literal secrets that do not look like env var names', () => {
    const resolved = resolveCustomConfig({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'sk-literal-secret',
    });

    expect(resolved.apiKey).toBe('sk-literal-secret');
  });

  it('fails when a configured env var name is missing without treating it as a secret', () => {
    expect(() => resolveCustomConfig({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      apiKey: 'OPENAI_API_KEY',
    })).toThrow(/OPENAI_API_KEY/);

    try {
      resolveCustomConfig({
        provider: 'openai',
        model: 'gpt-4.1-mini',
        apiKey: 'OPENAI_API_KEY',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('OPENAI_API_KEY');
      expect(message).not.toContain('sk-');
    }
  });

  it('fails with provider-specific default env var guidance when apiKey is absent', () => {
    expect(() => resolveCustomConfig({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('distinguishes missing provider and missing model errors', () => {
    expect(() => resolveCustomConfig({
      model: 'gpt-4.1-mini',
    } as CustomConfig)).toThrow(/custom\.provider/);

    expect(() => resolveCustomConfig({
      provider: 'openai',
    } as CustomConfig)).toThrow(/custom\.model/);
  });
});
