import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init, isInitialized, getVetoDir } from '../../src/cli/init.js';
import type { InitOptions } from '../../src/cli/init.js';
import type { VetoConfigFile } from '../../src/cli/config.js';
import { createDefaultConfigTemplate } from '../../src/cli/templates.js';

const TEST_DIR = '/tmp/veto-test-' + Date.now();

describe('CLI init', () => {
  beforeEach(() => {
    // Create fresh test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('init', () => {
    it('should expose only supported validation modes in init options and templates', () => {
      expectTypeOf<InitOptions['mode']>().toEqualTypeOf<
        'local' | 'api' | 'kernel' | 'custom' | undefined
      >();
      expectTypeOf<Parameters<typeof createDefaultConfigTemplate>[0]>().toEqualTypeOf<
        | {
            validationMode?: 'local' | 'api' | 'kernel' | 'custom';
            apiKey?: string;
          }
        | undefined
      >();
      expectTypeOf<NonNullable<VetoConfigFile['kernel']>['tokenVaultEnvVars']>()
        .toEqualTypeOf<string[] | undefined>();
      expectTypeOf<NonNullable<VetoConfigFile['custom']>['tokenVaultEnvVars']>()
        .toEqualTypeOf<string[] | undefined>();
    });

    it('should document token vault env vars for LLM validation modes', () => {
      const content = createDefaultConfigTemplate();

      expect(content).toContain(
        '#   # tokenVaultEnvVars: ["SERVICE_TOKEN"]  # Env var values to redact from LLM prompts'
      );
      expect(content).toContain(
        '#   # tokenVaultEnvVars: ["PAYMENTS_TOKEN"]  # Env var values to redact from LLM prompts'
      );
    });

    it('should create veto directory structure', async () => {
      const result = await init({ directory: TEST_DIR, quiet: true });

      expect(result.success).toBe(true);
      expect(result.vetoDir).toBe(join(TEST_DIR, 'veto'));
      expect(existsSync(join(TEST_DIR, 'veto'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'veto', 'rules'))).toBe(true);
    });

    it('should keep local mode by default', async () => {
      await init({ directory: TEST_DIR, quiet: true });

      const configPath = join(TEST_DIR, 'veto', 'veto.config.yaml');
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('version: "1.0"');
      expect(content).toContain('validation:');
      expect(content).toContain('mode: "local"');
    });

    it('should set api mode when cloud flag is provided', async () => {
      await init({ directory: TEST_DIR, cloud: true, quiet: true });

      const configPath = join(TEST_DIR, 'veto', 'veto.config.yaml');
      const content = readFileSync(configPath, 'utf-8');

      expect(content).toContain('validation:');
      expect(content).toContain('mode: "api"');
    });

    it('should write api key while keeping local mode by default', async () => {
      await init({
        directory: TEST_DIR,
        apiKey: 'veto_sk_xxx',
        quiet: true,
      });

      const configPath = join(TEST_DIR, 'veto', 'veto.config.yaml');
      const content = readFileSync(configPath, 'utf-8');

      expect(content).toContain('mode: "local"');
      expect(content).toContain('cloud:');
      expect(content).toContain('apiKey: "veto_sk_xxx"');
      expect(content).toContain('timeout: 30000');
      expect(content).toContain('retries: 2');
      expect(content).toContain('retryDelay: 1000');
    });

    it('should warn when api key is written to config', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      try {
        await init({
          directory: TEST_DIR,
          apiKey: 'veto_sk_xxx',
        });

        const output = consoleSpy.mock.calls.map(([message]) => String(message)).join('\n');
        expect(output).toContain(
          'Warning: API key written to veto/veto.config.yaml — do NOT commit this file, or set VETO_API_KEY env var instead.'
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('should set api mode and write api key when cloud and api-key are provided', async () => {
      await init({
        directory: TEST_DIR,
        cloud: true,
        apiKey: 'veto_sk_xxx',
        quiet: true,
      });

      const configPath = join(TEST_DIR, 'veto', 'veto.config.yaml');
      const content = readFileSync(configPath, 'utf-8');

      expect(content).toContain('mode: "api"');
      expect(content).toContain('cloud:');
      expect(content).toContain('apiKey: "veto_sk_xxx"');
      expect(content).toContain('timeout: 30000');
      expect(content).toContain('retries: 2');
      expect(content).toContain('retryDelay: 1000');
    });

    it('should create default rules file', async () => {
      await init({ directory: TEST_DIR, quiet: true });

      const rulesPath = join(TEST_DIR, 'veto', 'rules', 'defaults.yaml');
      expect(existsSync(rulesPath)).toBe(true);

      const content = readFileSync(rulesPath, 'utf-8');
      expect(content).toContain('rules:');
      expect(content).toContain('block-system-paths');
    });

    it('should scaffold extends when pack is provided', async () => {
      await init({
        directory: TEST_DIR,
        pack: '@veto/financial',
        quiet: true,
      });

      const rulesPath = join(TEST_DIR, 'veto', 'rules', 'defaults.yaml');
      const content = readFileSync(rulesPath, 'utf-8');
      expect(content).toContain('extends: "@veto/financial"');
      expect(content).not.toContain('block-system-paths');
    });

    it('should normalize bare pack names in init', async () => {
      await init({
        directory: TEST_DIR,
        pack: 'coding-agent',
        quiet: true,
      });

      const rulesPath = join(TEST_DIR, 'veto', 'rules', 'defaults.yaml');
      const content = readFileSync(rulesPath, 'utf-8');
      expect(content).toContain('extends: "@veto/coding-agent"');
    });

    it('should fail when an unknown pack is provided', async () => {
      const result = await init({
        directory: TEST_DIR,
        pack: '@veto/does-not-exist',
        quiet: true,
      });

      expect(result.success).toBe(false);
      expect(result.messages[0]).toContain('Unknown policy pack');
      expect(existsSync(join(TEST_DIR, 'veto'))).toBe(false);
    });

    it('should create .env.example file', async () => {
      await init({ directory: TEST_DIR, quiet: true });

      const envPath = join(TEST_DIR, 'veto', '.env.example');
      expect(existsSync(envPath)).toBe(true);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toContain('VETO_LOG_LEVEL');
    });

    it('should track created files', async () => {
      const result = await init({ directory: TEST_DIR, quiet: true });

      expect(result.createdFiles).toContain('veto/veto.config.yaml');
      expect(result.createdFiles).toContain('veto/rules/defaults.yaml');
      expect(result.createdFiles).toContain('veto/.env.example');
    });

    it('should not overwrite existing files without force', async () => {
      // First init
      await init({ directory: TEST_DIR, quiet: true });

      // Modify config
      const configPath = join(TEST_DIR, 'veto', 'veto.config.yaml');
      writeFileSync(configPath, 'custom: config', 'utf-8');

      // Second init without force
      const result = await init({ directory: TEST_DIR, quiet: true });

      expect(result.success).toBe(false);
      expect(result.messages).toContain(
        'Veto is already initialized in this directory. Use --force to overwrite.'
      );

      // Config should still be custom
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toBe('custom: config');
    });

    it('should overwrite existing files with force', async () => {
      // First init
      await init({ directory: TEST_DIR, quiet: true });

      // Modify config
      const configPath = join(TEST_DIR, 'veto', 'veto.config.yaml');
      writeFileSync(configPath, 'custom: config', 'utf-8');

      // Second init with force
      const result = await init({ directory: TEST_DIR, force: true, quiet: true });

      expect(result.success).toBe(true);

      // Config should be reset to default
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('version: "1.0"');
    });

    it('should update .gitignore if it exists', async () => {
      // Create .gitignore
      const gitignorePath = join(TEST_DIR, '.gitignore');
      writeFileSync(gitignorePath, 'node_modules/\n', 'utf-8');

      await init({ directory: TEST_DIR, quiet: true });

      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('veto/.env');
      expect(content).not.toContain('veto/veto.config.yaml');
    });

    it('should add veto config to .gitignore when api key is provided', async () => {
      const gitignorePath = join(TEST_DIR, '.gitignore');
      writeFileSync(gitignorePath, 'node_modules/\n', 'utf-8');

      await init({ directory: TEST_DIR, apiKey: 'veto_sk_xxx', quiet: true });

      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('veto/.env');
      expect(content).toContain('veto/veto.config.yaml');
    });

    it('should add only the missing veto config ignore entry for api-key init', async () => {
      const gitignorePath = join(TEST_DIR, '.gitignore');
      writeFileSync(gitignorePath, 'node_modules/\n# Veto\nveto/.env\nveto/*.local.yaml\n', 'utf-8');

      await init({ directory: TEST_DIR, apiKey: 'veto_sk_xxx', quiet: true });

      const content = readFileSync(gitignorePath, 'utf-8');
      const envMatches = content.match(/veto\/\.env/g);
      const configMatches = content.match(/veto\/veto\.config\.yaml/g);

      expect(envMatches).toHaveLength(1);
      expect(configMatches).toHaveLength(1);
    });

    it('should not duplicate .gitignore entries', async () => {
      // Create .gitignore with existing veto entry
      const gitignorePath = join(TEST_DIR, '.gitignore');
      writeFileSync(gitignorePath, 'node_modules/\nveto/.env\n', 'utf-8');

      await init({ directory: TEST_DIR, quiet: true });

      const content = readFileSync(gitignorePath, 'utf-8');
      const matches = content.match(/veto\/\.env/g);
      expect(matches).toHaveLength(1);
    });

    it('should not duplicate veto config .gitignore entries for api-key init', async () => {
      const gitignorePath = join(TEST_DIR, '.gitignore');
      writeFileSync(
        gitignorePath,
        'node_modules/\nveto/.env\nveto/veto.config.yaml\n',
        'utf-8'
      );

      await init({ directory: TEST_DIR, apiKey: 'veto_sk_xxx', quiet: true });

      const content = readFileSync(gitignorePath, 'utf-8');
      const matches = content.match(/veto\/veto\.config\.yaml/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('isInitialized', () => {
    it('should return false for uninitialized directory', () => {
      expect(isInitialized(TEST_DIR)).toBe(false);
    });

    it('should return true for initialized directory', async () => {
      await init({ directory: TEST_DIR, quiet: true });

      expect(isInitialized(TEST_DIR)).toBe(true);
    });

    it('should return false if only veto folder exists without config', () => {
      mkdirSync(join(TEST_DIR, 'veto'), { recursive: true });

      expect(isInitialized(TEST_DIR)).toBe(false);
    });
  });

  describe('getVetoDir', () => {
    it('should return null for uninitialized directory', () => {
      expect(getVetoDir(TEST_DIR)).toBe(null);
    });

    it('should return veto path for initialized directory', async () => {
      await init({ directory: TEST_DIR, quiet: true });

      expect(getVetoDir(TEST_DIR)).toBe(join(TEST_DIR, 'veto'));
    });
  });
});
