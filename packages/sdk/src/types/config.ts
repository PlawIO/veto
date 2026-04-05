/**
 * Configuration types for Veto guardrail system.
 *
 * @module types/config
 */

import type { Logger } from '../utils/logger.js';

export type StreamLogMode = 'compact' | 'verbose';

/**
 * Log level for Veto operations.
 * Controls the verbosity of internal logging.
 */
export type LogLevel = 'debug' | 'info' | 'stream' | 'warn' | 'error' | 'silent';

/**
 * Validation decision for a tool call.
 */
export type ValidationDecision = 'allow' | 'deny' | 'modify' | 'require_approval';

/**
 * Result of validating a tool call.
 */
export interface ValidationResult {
  /** Whether to allow, deny, or modify the tool call */
  decision: ValidationDecision;
  /** Human-readable reason for the decision */
  reason?: string;
  /** For 'modify' decisions, the modified arguments */
  modifiedArguments?: Record<string, unknown>;
  /** Additional metadata about the validation */
  metadata?: Record<string, unknown>;
}

/**
 * Context provided to validators for making decisions.
 */
export interface ValidationContext {
  /** Name of the tool being called */
  toolName: string;
  /** Arguments passed to the tool */
  arguments: Record<string, unknown>;
  /** Unique ID of this tool call */
  callId: string;
  /** Timestamp when the call was initiated */
  timestamp: Date;
  /** History of previous tool calls in this session */
  callHistory: readonly ToolCallHistoryEntry[];
  /** Session identifier for this call (falls back to instance-level session when omitted) */
  sessionId?: string;
  /** Agent identifier for this call (falls back to instance-level agent when omitted) */
  agentId?: string;
  /** User identifier for this call (falls back to instance-level user when omitted) */
  userId?: string;
  /** Role for this call (falls back to instance-level role when omitted) */
  role?: string;
  /** Indicates whether validation is being run for interception or standalone guard checks */
  source?: 'interceptor' | 'guard';
  /** Custom context data passed by the user */
  custom?: Record<string, unknown>;
}

/**
 * Entry in the tool call history.
 */
export interface ToolCallHistoryEntry {
  /** Name of the tool that was called */
  toolName: string;
  /** Arguments passed to the tool */
  arguments: Record<string, unknown>;
  /** The validation result for this call */
  validationResult: ValidationResult;
  /** When the call was made */
  timestamp: Date;
  /** Duration of the tool execution in milliseconds (if executed) */
  durationMs?: number;
}

/**
 * Supported formats when exporting decision history.
 */
export type DecisionExportFormat = 'json' | 'csv';

/**
 * Serializable decision record returned by exportDecisions.
 */
export interface DecisionExportRecord {
  timestamp: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  policy_version: string | null;
  rule_id: string | null;
  decision: ValidationDecision;
  reason: string | null;
  chain_hash?: string;
}

/**
 * Validator function type for custom validation logic.
 *
 * @param context - Context about the tool call being validated
 * @returns Validation result, or a promise that resolves to one
 *
 * @example
 * ```typescript
 * const noDeleteValidator: Validator = async (context) => {
 *   if (context.toolName === 'delete_file') {
 *     return {
 *       decision: 'deny',
 *       reason: 'File deletion is not allowed'
 *     };
 *   }
 *   return { decision: 'allow' };
 * };
 * ```
 */
export type Validator = (
  context: ValidationContext
) => ValidationResult | Promise<ValidationResult>;

/**
 * Named validator with optional configuration.
 */
export interface NamedValidator {
  /** Unique name for this validator */
  name: string;
  /** Description of what this validator does */
  description?: string;
  /** The validation function */
  validate: Validator;
  /** Priority order (lower runs first, default: 100) */
  priority?: number;
  /** Only run for these tool names (if not specified, runs for all) */
  toolFilter?: string[];
}

/**
 * Configuration options for the Veto instance.
 */
export interface VetoConfig {
  /**
   * List of validators to run on each tool call.
   * Validators run in priority order (lower first).
   * If any validator denies, the call is blocked.
   */
  validators?: (Validator | NamedValidator)[];

  /**
   * Default decision when no validators are configured.
   * @default 'allow'
   */
  defaultDecision?: ValidationDecision;

  /**
   * Log level for internal operations.
   * @default 'info'
   */
  logLevel?: LogLevel;

  /**
   * Custom logger implementation.
   * If not provided, uses the built-in console logger.
   */
  logger?: Logger;

  /**
   * Whether to track tool call history.
   * History is provided to validators for context.
   * @default true
   */
  trackHistory?: boolean;

  /**
   * Maximum number of history entries to keep.
   * Older entries are discarded when limit is reached.
   * @default 100
   */
  maxHistorySize?: number;

  /**
   * Custom context data available to all validators.
   */
  customContext?: Record<string, unknown>;

  /**
   * Hook called before validation runs.
   * Can be used for logging, metrics, etc.
   */
  onBeforeValidation?: (context: ValidationContext) => void | Promise<void>;

  /**
   * Hook called after validation completes.
   * Can be used for logging, metrics, etc.
   */
  onAfterValidation?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;

  /**
   * Hook called when a tool call is denied.
   * Can be used for alerting, logging, etc.
   */
  onDenied?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
}

/**
 * Resolved configuration with all defaults applied.
 */
export interface ResolvedVetoConfig extends Required<Omit<VetoConfig, 'logger' | 'customContext' | 'onBeforeValidation' | 'onAfterValidation' | 'onDenied'>> {
  logger: Logger;
  customContext?: Record<string, unknown>;
  onBeforeValidation?: (context: ValidationContext) => void | Promise<void>;
  onAfterValidation?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
  onDenied?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
}

/**
 * Helper to check if a validator is a named validator.
 */
export function isNamedValidator(
  validator: Validator | NamedValidator
): validator is NamedValidator {
  return (
    typeof validator === 'object' &&
    validator !== null &&
    'name' in validator &&
    'validate' in validator
  );
}

/**
 * Normalize a validator to NamedValidator format.
 */
export function normalizeValidator(
  validator: Validator | NamedValidator,
  index: number
): NamedValidator {
  if (isNamedValidator(validator)) {
    return {
      priority: 100,
      ...validator,
    };
  }
  return {
    name: `validator-${index}`,
    validate: validator,
    priority: 100,
  };
}
