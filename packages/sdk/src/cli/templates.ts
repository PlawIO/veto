import { stringify as stringifyYaml } from 'yaml';

/**
 * Default templates for veto init.
 *
 * @module cli/templates
 */


export interface DefaultConfigTemplateOptions {
  validationMode?: 'local' | 'api' | 'kernel' | 'custom' | 'cloud';
  apiKey?: string;
}

export function createDefaultConfigTemplate(options: DefaultConfigTemplateOptions = {}): string {
  const validationMode = options.validationMode ?? 'local';
  const cloud: Record<string, unknown> = {
    baseUrl: 'https://api.veto.so',
    timeout: 30000,
    retries: 2,
    retryDelay: 1000,
  };

  if (options.apiKey) {
    cloud.apiKey = options.apiKey;
  }

  const content = stringifyYaml({
    version: '1.0',
    mode: 'strict',
    validation: {
      mode: validationMode,
    },
    cloud,
    logging: {
      level: 'info',
    },
    rules: {
      directory: './rules',
      recursive: true,
    },
  }, { lineWidth: 0 });

  return `# Veto Configuration
# See README.md for documentation

${content}`;
}

/**
 * Default veto.config.yaml content.
 */
export const DEFAULT_CONFIG = createDefaultConfigTemplate();

/**
 * Default rules/defaults.yaml content.
 */
export const DEFAULT_RULES = `# Veto Default Rules
# Add your rules here. Create additional .yaml files for organization.

version: "1.0"
name: default-rules
description: Default security rules

rules:
  # Block access to system directories
  - id: block-system-paths
    name: Block system path access
    description: Prevent access to sensitive system directories
    enabled: true
    severity: critical
    action: block
    tools:
      - read_file
      - write_file
      - delete_file
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc

  # Block access to root home
  - id: block-root-home
    name: Block root home access
    description: Prevent access to root user directory
    enabled: true
    severity: critical
    action: block
    tools:
      - read_file
      - write_file
      - delete_file
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /root

  # Block destructive commands
  - id: block-rm-rf
    name: Block rm -rf
    description: Prevent recursive forced deletion
    enabled: true
    severity: critical
    action: block
    tools:
      - execute_command
      - run_shell
      - bash
    conditions:
      - field: arguments.command
        operator: contains
        value: "rm -rf"

  # Block privilege escalation
  - id: block-sudo
    name: Block sudo
    description: Prevent privilege escalation
    enabled: true
    severity: critical
    action: block
    tools:
      - execute_command
      - run_shell
      - bash
    conditions:
      - field: arguments.command
        operator: starts_with
        value: sudo
`;

/**
 * Rules template that extends a built-in policy pack.
 */
export function createPackRulesTemplate(packName: string): string {
  return `# Veto Rules
# This file extends a built-in policy pack and lets you override specific rules.

version: "1.0"
name: custom-rules
description: Custom rules extending ${packName}
extends: "${packName}"

rules:
  # Override a pack rule by reusing the same id:
  # - id: <pack-rule-id>
  #   name: My override
  #   action: block

  # Add project-specific rules:
  # - id: project-specific-rule
  #   name: Project specific rule
  #   action: block
`;
}

/**
 * .gitignore additions for veto.
 */
export const GITIGNORE_ADDITIONS = `
# Veto
veto/.env
veto/*.local.yaml
`;

/**
 * Example .env file content.
 */
export const ENV_EXAMPLE = `# Veto Environment Variables
# Copy this to .env and fill in values

# Override log level (debug, info, warn, error, silent)
# VETO_LOG_LEVEL=debug

# Session/Agent tracking (optional)
# VETO_SESSION_ID=
# VETO_AGENT_ID=

# Cloud mode (auto-detected when set)
# VETO_API_KEY=veto_...

# Custom LLM Provider API Keys (for validation.mode: "custom")
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GEMINI_API_KEY=...
# OPENROUTER_API_KEY=sk-or-...
`;
