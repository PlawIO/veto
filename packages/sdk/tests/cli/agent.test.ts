import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentConfig } from '../../src/cli/agent.js';

const TEST_DIR = `/tmp/veto-agent-cli-test-${Date.now()}`;

describe('agent cli commands', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(join(TEST_DIR, 'veto'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('redacts secret-like configuration keys recursively', async () => {
    writeFileSync(join(TEST_DIR, 'veto', 'veto.config.yaml'), `version: "1.0"
api:
  baseUrl: "https://api.example.test"
  apiKey: "veto_secret_api_key"
  headers:
    Authorization: "Bearer hidden-token"
cloud:
  accessToken: "cloud-access-token"
  nested:
    refresh_token: "cloud-refresh-token"
safe:
  tokenBudget: 100
  values:
    - secret: "array-secret"
`, 'utf-8');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await agentConfig({ directory: TEST_DIR });

    expect(result.success).toBe(true);
    expect(result.data?.api).toMatchObject({
      baseUrl: 'https://api.example.test',
      apiKey: '[REDACTED]',
      headers: {
        Authorization: '[REDACTED]',
      },
    });
    expect(result.data?.cloud).toMatchObject({
      accessToken: '[REDACTED]',
      nested: {
        refresh_token: '[REDACTED]',
      },
    });
    expect(JSON.stringify(result.data)).not.toContain('hidden-token');
    expect(JSON.stringify(result.data)).not.toContain('cloud-refresh-token');

    const printed = JSON.parse(String(log.mock.calls[0]?.[0])) as { data?: unknown };
    expect(JSON.stringify(printed.data)).not.toContain('veto_secret_api_key');
  });
});
