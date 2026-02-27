/**
 * Default templates for veto init.
 *
 * @module cli/templates
 */

/**
 * Default veto.config.yaml content.
 */
export const DEFAULT_CONFIG = `# Veto Configuration
# See README.md for documentation

version: "1.0"

# Operating mode:
#   "strict" - Block tool calls when validation fails
#   "log"    - Only log validation failures, allow calls to proceed
mode: "strict"

# Validation mode:
#   "local"  - Evaluate YAML rules locally (default, zero network calls)
#   "cloud"  - Use Veto Cloud API (set VETO_API_KEY)
#   "kernel" - Use local Ollama model
#   "custom" - Use specified LLM provider
validation:
  mode: "local"

# Cloud configuration (for mode: "cloud")
# cloud:
#   # apiKey: "veto_..."  # Or set VETO_API_KEY env var
#   # baseUrl: "https://api.veto.so"  # Set to your endpoint for self-hosted
#   timeout: 30000
#   retries: 2
#   retryDelay: 1000

# Kernel configuration (for mode: "kernel")
# kernel:
#   baseUrl: "http://localhost:11434/v1"
#   model: "hf.co/ycaleb/veto-warden-4b-GGUF:Q4_K_M"
#   temperature: 0.1
#   maxTokens: 256

# Custom LLM provider (for mode: "custom")
# custom:
#   provider: "openai"  # openai | anthropic | gemini | openrouter
#   model: "gpt-4o"
#   # apiKey: "sk-..."  # Or set OPENAI_API_KEY env var
#   temperature: 0.1
#   maxTokens: 500
#   # baseUrl: "https://api.openai.com/v1"  # Optional override

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
logging:
  level: "info"  # debug, info, warn, error, silent

# Rules configuration
rules:
  directory: "./rules"
  recursive: true

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
