/**
 * Default templates for veto init.
 *
 * @module cli/templates
 */

import { Document, Scalar, isMap, stringify as stringifyYaml } from 'yaml';

export interface DefaultConfigTemplateOptions {
  validationMode?: 'local' | 'api' | 'kernel' | 'custom';
  apiKey?: string;
}

interface DefaultConfigShape {
  [key: string]: unknown;
}

function setQuotedScalar(
  document: Document,
  path: string[]
): void {
  let current: unknown = document.contents;

  for (let index = 0; index < path.length; index += 1) {
    if (!current || !isMap(current)) {
      return;
    }

    const pair = current.items.find((entry) => {
      const key = entry.key;
      return key instanceof Scalar && key.value === path[index];
    });

    if (!pair) {
      return;
    }

    if (index === path.length - 1) {
      if (pair.value instanceof Scalar) {
        pair.value.type = Scalar.QUOTE_DOUBLE;
      }
      return;
    }

    current = pair.value;
  }
}

function createYamlSection(
  data: DefaultConfigShape,
  quotedPaths: string[][]
): string {
  const document = new Document(data);

  for (const path of quotedPaths) {
    setQuotedScalar(document, path);
  }

  return stringifyYaml(document).trimEnd();
}

/**
 * Default veto.config.yaml content.
 */
export function createDefaultConfigTemplate(
  options: DefaultConfigTemplateOptions = {}
): string {
  const validationMode = options.validationMode ?? 'local';
  const baseConfigYaml = createYamlSection(
    {
      version: '1.0',
      mode: 'strict',
      validation: {
        mode: validationMode,
      },
    },
    [['version'], ['mode'], ['validation', 'mode']]
  );
  const cloudConfigYaml = options.apiKey === undefined
    ? `# cloud:
#   # apiKey: "veto_..."  # Or set VETO_API_KEY env var
#   # baseUrl: "https://api.veto.so"  # Set to your endpoint for self-hosted
#   timeout: 30000
#   retries: 2
#   retryDelay: 1000`
    : `${createYamlSection(
        {
          cloud: {
            apiKey: options.apiKey,
            timeout: 30000,
            retries: 2,
            retryDelay: 1000,
          },
        },
        [['cloud', 'apiKey']]
      )}
  # baseUrl: "https://api.veto.so"  # Set to your endpoint for self-hosted`;
  const loggingYaml = createYamlSection(
    {
      logging: {
        level: 'info',
      },
    },
    [['logging', 'level']]
  );
  const rulesYaml = createYamlSection(
    {
      rules: {
        directory: './rules',
        recursive: true,
      },
    },
    [['rules', 'directory']]
  );

  return `# Veto Configuration
# See README.md for documentation

${baseConfigYaml}

# Validation mode notes:
#   "local"  - Evaluate YAML rules locally (default, zero network calls)
#   "api"    - Use Veto Cloud API or an external HTTP validation API
#   "kernel" - Use local Ollama model
#   "custom" - Use specified LLM provider

# Cloud configuration defaults (for mode: "api")
${cloudConfigYaml}

# Kernel configuration (for mode: "kernel")
# kernel:
#   baseUrl: "http://localhost:11434/v1"
#   model: "hf.co/ycaleb/veto-warden-4b-GGUF:Q4_K_M"
#   temperature: 0.1
#   maxTokens: 256

# Custom LLM provider (for mode: "custom")
# custom:
#   provider: "openai"  # openai | anthropic | gemini | openrouter
#   model: "gpt-5.4"
#   # apiKey: "OPENAI_API_KEY"  # Env var names are supported and safer than literal secrets
#   temperature: 0.1
#   maxTokens: 500
#   # baseUrl: "https://api.openai.com/v1"  # Optional override

# Optional semantic PII detector for output_rules with metadata.detector: "nvidia-gliner-pii"
# pii:
#   enabled: false
#   provider: "nvidia-gliner-pii"
#   # apiKey: "NVIDIA_API_KEY"  # Prefer NVIDIA_API_KEY or VETO_NVIDIA_API_KEY env vars
#   model: "nvidia/gliner-pii"
#   threshold: 0.45
#   timeout: 5000
#   maxFields: 32
#   maxTextChars: 8000

# Human-in-the-loop approvals (for action: "require_approval" in local rules)
# approval:
#   callbackUrl: "http://localhost:8787/approvals"
#   timeout: 30000
#   timeoutBehavior: "block"  # "block" (default) or "allow"
#   includeCustomContext: false # opt-in: forward validation context.custom to webhook
#   responseSchema:
#     decisionField: "decision"
#     reasonField: "reason"

# Logging
${loggingYaml}  # debug, info, warn, error, silent

# Rules configuration
${rulesYaml}

# Veto Studio configuration
# studio:
#   workspace:
#     # Persisted startup workspace (absolute or relative path)
#     defaultDirectory: "."
#     includeExamples: false
#     includeTests: false
#   generation:
#     # If false, Studio blocks generation when no endpoint is configured
#     allowTemplateFallback: false
#   renderer:
#     preferred: "auto" # auto | ink | opentui | ansi
`;
}

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

export function createGitignoreAdditions(apiKey?: string): string {
  if (!apiKey) {
    return GITIGNORE_ADDITIONS;
  }

  return `${GITIGNORE_ADDITIONS}veto/veto.config.yaml
`;
}

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
