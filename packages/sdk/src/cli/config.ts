/**
 * Configuration loader for Veto projects.
 *
 * Loads configuration from veto.config.yaml and initializes
 * the rule validator with the configured settings.
 *
 * @module cli/config
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from '../utils/logger.js';
import { createLogger } from '../utils/logger.js';
import type { LogLevel } from '../types/config.js';
import { RuleValidator } from '../rules/rule-validator.js';
import type { RuleValidatorConfig } from '../rules/rule-validator.js';
import type { ValidationAPIConfig } from '../rules/api-client.js';
import type { YamlParser } from '../rules/loader.js';
import { resolvePolicyRulesDirectory } from './policy-paths.js';

/**
 * Parsed veto.config.yaml structure.
 */
export interface VetoConfigFile {
  version?: string;
  api?: {
    baseUrl?: string;
    endpoint?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
    apiKey?: string;
  };
  validation?: {
    failMode?: 'open' | 'closed';
    defaultDecision?: 'allow' | 'block';
  };
  logging?: {
    level?: LogLevel;
  };
  rules?: {
    directory?: string;
    recursive?: boolean;
  };
  kernel?: {
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    tokenVaultEnvVars?: string[];
  };
  custom?: {
    provider?: 'openai' | 'anthropic' | 'gemini' | 'openrouter';
    model?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    baseUrl?: string;
    tokenVaultEnvVars?: string[];
  };
  session?: {
    sessionHeader?: string;
    agentHeader?: string;
  };
}

/**
 * Loaded Veto configuration with initialized components.
 */
export interface LoadedVetoConfig {
  /** Path to the veto directory */
  vetoDir: string;
  /** Path to the config file */
  configPath: string;
  /** Raw parsed config */
  raw: VetoConfigFile;
  /** Resolved API configuration */
  apiConfig: ValidationAPIConfig;
  /** Log level */
  logLevel: LogLevel;
  /** Fail mode */
  failMode: 'open' | 'closed';
  /** Rules directory path */
  rulesDir: string;
  /** Whether to search subdirectories */
  recursiveRules: boolean;
  /** Logger instance */
  logger: Logger;
  /** Rule validator (call initialize() before use) */
  validator: RuleValidator;
}

/**
 * Options for loading configuration.
 */
export interface LoadConfigOptions {
  /** YAML parser function (required) */
  yamlParser: YamlParser;
  /** Override log level */
  logLevel?: LogLevel;
  /** Override API base URL */
  apiBaseUrl?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Session ID for tracking */
  sessionId?: string;
  /** Agent ID for tracking */
  agentId?: string;
  /** Custom logger */
  logger?: Logger;
}

/**
 * Load Veto configuration from a directory.
 *
 * @param vetoDir - Path to the veto directory (containing veto.config.yaml)
 * @param options - Loading options
 * @returns Loaded configuration with initialized validator
 *
 * @example
 * ```typescript
 * import yaml from 'js-yaml';
 * import { loadVetoConfig } from 'veto/config';
 *
 * const config = await loadVetoConfig('./veto', {
 *   yamlParser: yaml.load,
 * });
 *
 * await config.validator.initialize();
 *
 * const veto = new Veto({
 *   validators: [config.validator.toNamedValidator()],
 * });
 * ```
 */
export async function loadVetoConfig(
  vetoDir: string,
  options: LoadConfigOptions
): Promise<LoadedVetoConfig> {
  const resolvedVetoDir = resolve(vetoDir);
  const configPath = join(resolvedVetoDir, 'veto.config.yaml');

  // Check if config exists
  if (!existsSync(configPath)) {
    throw new Error(
      `Veto configuration not found at ${configPath}. Run 'veto init' first.`
    );
  }

  // Read and parse config
  const configContent = readFileSync(configPath, 'utf-8');
  const rawConfig = options.yamlParser(configContent) as VetoConfigFile;

  // Resolve values with defaults and overrides
  const logLevel = options.logLevel ?? rawConfig.logging?.level ?? 'info';
  const logger = options.logger ?? createLogger(logLevel);

  // Build API config
  const apiConfig: ValidationAPIConfig = {
    baseUrl: options.apiBaseUrl ?? rawConfig.api?.baseUrl ?? 'http://localhost:8080',
    endpoint: rawConfig.api?.endpoint ?? '/tool/call/check',
    timeout: rawConfig.api?.timeout ?? 10000,
    retries: rawConfig.api?.retries ?? 2,
    retryDelay: rawConfig.api?.retryDelay ?? 1000,
    apiKey: options.apiKey ?? rawConfig.api?.apiKey,
  };

  // Resolve rules directory
  const rulesDir = resolvePolicyRulesDirectory({
    vetoDir: resolvedVetoDir,
    configuredDirectory: rawConfig.rules?.directory,
    requireExists: true,
  });
  const recursiveRules = rawConfig.rules?.recursive ?? true;

  // Fail mode
  const failMode = rawConfig.validation?.failMode ?? 'closed';

  // Create rule validator config
  const validatorConfig: RuleValidatorConfig = {
    api: apiConfig,
    rulesDir: rulesDir,
    yamlParser: options.yamlParser,
    recursiveRuleSearch: recursiveRules,
    strictRuleLoading: true,
    failMode: failMode,
    sessionId: options.sessionId,
    agentId: options.agentId,
  };

  // Create validator
  const validator = new RuleValidator({
    config: validatorConfig,
    logger: logger,
  });

  return {
    vetoDir: resolvedVetoDir,
    configPath,
    raw: rawConfig,
    apiConfig,
    logLevel,
    failMode,
    rulesDir,
    recursiveRules,
    logger,
    validator,
  };
}

/**
 * Find the veto directory by searching up from a starting directory.
 *
 * @param startDir - Directory to start searching from
 * @returns Path to veto directory, or null if not found
 */
export function findVetoDir(startDir: string = process.cwd()): string | null {
  let currentDir = resolve(startDir);
  const root = resolve('/');

  while (currentDir !== root) {
    const vetoDir = join(currentDir, 'veto');
    const configPath = join(vetoDir, 'veto.config.yaml');

    if (existsSync(configPath)) {
      return vetoDir;
    }

    currentDir = resolve(currentDir, '..');
  }

  return null;
}

/**
 * Load environment variables for Veto.
 *
 * Reads from process.env with VETO_ prefix.
 *
 * @returns Environment variable overrides
 */
export function loadEnvOverrides(): Partial<LoadConfigOptions> {
  const overrides: Partial<LoadConfigOptions> = {};

  if (process.env.VETO_API_URL) {
    overrides.apiBaseUrl = process.env.VETO_API_URL;
  }

  if (process.env.VETO_API_KEY) {
    overrides.apiKey = process.env.VETO_API_KEY;
  }

  if (process.env.VETO_LOG_LEVEL) {
    overrides.logLevel = process.env.VETO_LOG_LEVEL as LogLevel;
  }

  if (process.env.VETO_SESSION_ID) {
    overrides.sessionId = process.env.VETO_SESSION_ID;
  }

  if (process.env.VETO_AGENT_ID) {
    overrides.agentId = process.env.VETO_AGENT_ID;
  }

  return overrides;
}
