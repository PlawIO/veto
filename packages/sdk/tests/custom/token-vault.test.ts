import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/utils/logger.js';
import { CustomClient } from '../../src/custom/client.js';
import { createEnvTokenVault, maskVaultedResponse } from '../../src/custom/token-vault.js';

const openAiMock = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      chat: {
        completions: {
          create: openAiMock.create,
        },
      },
    };
  }),
}));

const ORIGINAL_ENV = { ...process.env };

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('token vault', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('redacts configured env var values with opaque placeholders', () => {
    const vault = createEnvTokenVault({
      env: {
        SERVICE_KEY: 'svc_test_secret_123',
        PATH: '/usr/bin',
      },
      envVarNames: ['SERVICE_KEY'],
    });

    const redacted = vault.redactText('token=svc_test_secret_123 path=/usr/bin');

    expect(redacted).toContain('__VETO_TOKEN_VAULT_1__');
    expect(redacted).not.toContain('SERVICE_KEY');
    expect(redacted).not.toContain('svc_test_secret_123');
    expect(redacted).toContain('/usr/bin');
    expect(vault.restoreText(redacted)).toBe('token=svc_test_secret_123 path=/usr/bin');
  });

  it('redacts secret-looking env vars automatically without redacting non-secret vars', () => {
    const vault = createEnvTokenVault({
      env: {
        GITHUB_TOKEN: 'ghp_secret_value',
        HOME: '/home/user',
      },
    });

    const redacted = vault.redactText('send ghp_secret_value from /home/user');

    expect(redacted).toContain('__VETO_TOKEN_VAULT_1__');
    expect(redacted).not.toContain('ghp_secret_value');
    expect(redacted).toContain('/home/user');
  });

  it('ignores short auto-detected env values to avoid broad accidental replacements', () => {
    const vault = createEnvTokenVault({
      env: {
        API_TOKEN: 'test',
      },
    });

    expect(vault.entries).toHaveLength(0);
    expect(vault.redactText('this is a test')).toBe('this is a test');
  });

  it('redacts JSON-escaped secret forms', () => {
    const vault = createEnvTokenVault({
      env: {
        SERVICE_KEY: 'secret"with\\slashes',
      },
      envVarNames: ['SERVICE_KEY'],
    });

    const serialized = JSON.stringify({ token: 'secret"with\\slashes' });
    const redacted = vault.redactText(serialized);

    expect(redacted).toContain('__VETO_TOKEN_VAULT_1__');
    expect(redacted).not.toContain('secret');
  });

  it('round-trips secrets that contain replacement metacharacters', () => {
    const vault = createEnvTokenVault({
      env: {
        SERVICE_KEY: 'sk_$&_$1_secret',
      },
      envVarNames: ['SERVICE_KEY'],
    });

    const redacted = vault.redactText('token=sk_$&_$1_secret');

    expect(redacted).toBe('token=__VETO_TOKEN_VAULT_1__');
    expect(vault.restoreText(redacted)).toBe('token=sk_$&_$1_secret');
  });

  it('redacts overlapping secrets longest first', () => {
    const vault = createEnvTokenVault({
      env: {
        SHORT_TOKEN: 'token',
        LONG_TOKEN: 'token-super-secret',
      },
      envVarNames: ['SHORT_TOKEN', 'LONG_TOKEN'],
    });

    const redacted = vault.redactText('token-super-secret token');

    expect(redacted).toBe('__VETO_TOKEN_VAULT_2__ __VETO_TOKEN_VAULT_1__');
    expect(redacted).not.toContain('token-super-secret');
    expect(vault.restoreText(redacted)).toBe('token-super-secret token');
  });

  it('masks placeholders in parsed LLM response fields without restoring secrets', () => {
    const vault = createEnvTokenVault({
      env: { STRIPE_API_KEY: 'sk_live_secret' },
    });

    const response = maskVaultedResponse(
      {
        pass_weight: 0.1,
        block_weight: 0.9,
        decision: 'block' as const,
        reasoning: 'Blocked __VETO_TOKEN_VAULT_1__',
        matched_rules: ['rule-__VETO_TOKEN_VAULT_1__'],
      },
      vault
    );

    expect(response.reasoning).toBe('Blocked [REDACTED_ENV:STRIPE_API_KEY]');
    expect(response.matched_rules).toEqual(['rule-[REDACTED_ENV:STRIPE_API_KEY]']);
    expect(response.reasoning).not.toContain('sk_live_secret');
  });

  it('redacts tool-call secrets before custom LLM requests and masks placeholder responses', async () => {
    process.env.OPENAI_API_KEY = 'sk-provider-key';
    process.env.PAYMENTS_TOKEN = 'pay_secret_123456';
    openAiMock.create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              pass_weight: 0.1,
              block_weight: 0.9,
              decision: 'block',
              reasoning: 'The request exposes __VETO_TOKEN_VAULT_1__',
            }),
          },
        },
      ],
    });

    const client = new CustomClient({
      config: {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'OPENAI_API_KEY',
        tokenVaultEnvVars: ['PAYMENTS_TOKEN'],
      },
      logger,
    });

    const result = await client.evaluate(
      { tool: 'charge_card', arguments: { apiKey: 'pay_secret_123456' } },
      []
    );

    const request = openAiMock.create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const userPrompt = request.messages[1].content;
    expect(userPrompt).toContain('__VETO_TOKEN_VAULT_1__');
    expect(userPrompt).not.toContain('PAYMENTS_TOKEN');
    expect(userPrompt).not.toContain('pay_secret_123456');
    expect(result.reasoning).toBe('The request exposes [REDACTED_ENV:PAYMENTS_TOKEN]');
    expect(result.reasoning).not.toContain('pay_secret_123456');
  });
});
