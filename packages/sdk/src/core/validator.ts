/**
 * Validation engine for tool calls.
 *
 * This module handles running validators and aggregating their results.
 *
 * @module core/validator
 */

import type {
  NamedValidator,
  ValidationContext,
  ValidationResult,
  Validator,
} from '../types/config.js';
import { normalizeValidator } from '../types/config.js';
import type { Logger } from '../utils/logger.js';

/**
 * Options for the validation engine.
 */
export interface ValidationEngineOptions {
  /** Logger instance */
  logger: Logger;
  /** Default decision when no validators match */
  defaultDecision: 'allow' | 'deny' | 'modify';
}

/**
 * Result of running all validators.
 */
export interface AggregatedValidationResult {
  /** Final decision after running all validators */
  finalResult: ValidationResult;
  /** Results from individual validators */
  validatorResults: Array<{
    validatorName: string;
    result: ValidationResult;
    durationMs: number;
  }>;
  /** Total duration of validation in milliseconds */
  totalDurationMs: number;
}

/**
 * Validation engine that runs multiple validators in sequence.
 */
export class ValidationEngine {
  private readonly validators: NamedValidator[] = [];
  private readonly logger: Logger;
  private readonly defaultDecision: 'allow' | 'deny' | 'modify';

  constructor(options: ValidationEngineOptions) {
    this.logger = options.logger;
    this.defaultDecision = options.defaultDecision;
  }

  /**
   * Add a validator to the engine.
   *
   * @param validator - Validator function or named validator
   */
  addValidator(validator: Validator | NamedValidator): void {
    const normalized = normalizeValidator(validator, this.validators.length);
    this.validators.push(normalized);
    this.sortValidators();
    this.logger.debug('Validator added', {
      name: normalized.name,
      priority: normalized.priority,
      totalValidators: this.validators.length,
    });
  }

  /**
   * Add multiple validators at once.
   *
   * @param validators - Array of validators to add
   */
  addValidators(validators: Array<Validator | NamedValidator>): void {
    for (const validator of validators) {
      const normalized = normalizeValidator(validator, this.validators.length);
      this.validators.push(normalized);
    }
    this.sortValidators();
    this.logger.debug('Validators added', {
      count: validators.length,
      totalValidators: this.validators.length,
    });
  }

  /**
   * Remove a validator by name.
   *
   * @param name - Name of the validator to remove
   * @returns True if the validator was found and removed
   */
  removeValidator(name: string): boolean {
    const index = this.validators.findIndex((v) => v.name === name);
    if (index !== -1) {
      this.validators.splice(index, 1);
      this.logger.debug('Validator removed', { name });
      return true;
    }
    return false;
  }

  /**
   * Clear all validators.
   */
  clearValidators(): void {
    this.validators.length = 0;
    this.logger.debug('All validators cleared');
  }

  /**
   * Get the current list of validators.
   */
  getValidators(): readonly NamedValidator[] {
    return this.validators;
  }

  /**
   * Run all applicable validators for a tool call.
   *
   * Validators run in priority order. If any validator returns 'deny',
   * validation stops immediately and returns the denial.
   *
   * @param context - Validation context
   * @returns Aggregated validation result
   */
  async validate(context: ValidationContext): Promise<AggregatedValidationResult> {
    const startTime = performance.now();
    const validatorResults: AggregatedValidationResult['validatorResults'] = [];

    // Get validators that apply to this tool
    const applicableValidators = this.getApplicableValidators(context.toolName);

    this.logger.debug('Starting validation', {
      toolName: context.toolName,
      callId: context.callId,
      validatorCount: applicableValidators.length,
    });

    // If no validators, return default decision
    if (applicableValidators.length === 0) {
      const defaultResult: ValidationResult = { decision: this.defaultDecision };
      this.logger.debug('No applicable validators, using default decision', {
        decision: this.defaultDecision,
      });
      return {
        finalResult: defaultResult,
        validatorResults: [],
        totalDurationMs: performance.now() - startTime,
      };
    }

    let finalResult: ValidationResult = { decision: 'allow' };
    let currentContext = context;

    // Run validators in sequence
    for (const validator of applicableValidators) {
      const validatorStart = performance.now();

      try {
        const result = await validator.validate(currentContext);
        const durationMs = performance.now() - validatorStart;

        validatorResults.push({
          validatorName: validator.name,
          result,
          durationMs,
        });

        this.logger.debug('Validator completed', {
          validatorName: validator.name,
          decision: result.decision,
          durationMs: Math.round(durationMs * 100) / 100,
        });

        // Handle different decisions
        if (result.decision === 'deny') {
          // Stop on first denial
          finalResult = result;
          this.logger.info('Tool call denied by validator', {
            toolName: context.toolName,
            callId: context.callId,
            validator: validator.name,
            reason: result.reason,
          });
          break;
        } else if (result.decision === 'require_approval') {
          // Stop on approval requirement so callers can route to HITL flows.
          finalResult = result;
          this.logger.info('Tool call requires approval by validator', {
            toolName: context.toolName,
            callId: context.callId,
            validator: validator.name,
            reason: result.reason,
          });
          break;
        } else if (result.decision === 'modify' && result.modifiedArguments) {
          // Update context with modified arguments for next validator
          currentContext = {
            ...currentContext,
            arguments: result.modifiedArguments,
          };
          finalResult = result;
        } else if (result.decision === 'allow') {
          // Continue to next validator
          finalResult = result;
        }
      } catch (error) {
        const durationMs = performance.now() - validatorStart;
        const errorMessage = error instanceof Error ? error.message : String(error);

        this.logger.error(
          'Validator threw an error',
          {
            validatorName: validator.name,
            toolName: context.toolName,
            callId: context.callId,
          },
          error instanceof Error ? error : new Error(errorMessage)
        );

        // Treat validator errors as denials for safety
        validatorResults.push({
          validatorName: validator.name,
          result: {
            decision: 'deny',
            reason: `Validator error: ${errorMessage}`,
          },
          durationMs,
        });

        finalResult = {
          decision: 'deny',
          reason: `Validator "${validator.name}" threw an error: ${errorMessage}`,
        };
        break;
      }
    }

    const totalDurationMs = performance.now() - startTime;

    this.logger.debug('Validation complete', {
      toolName: context.toolName,
      callId: context.callId,
      finalDecision: finalResult.decision,
      totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    });

    return {
      finalResult,
      validatorResults,
      totalDurationMs,
    };
  }

  /**
   * Sort validators by priority (lower runs first).
   */
  private sortValidators(): void {
    this.validators.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /**
   * Get validators that apply to a specific tool.
   */
  private getApplicableValidators(toolName: string): NamedValidator[] {
    return this.validators.filter((validator) => {
      // If no filter specified, validator applies to all tools
      if (!validator.toolFilter || validator.toolFilter.length === 0) {
        return true;
      }
      // Check if tool name is in the filter list
      return validator.toolFilter.includes(toolName);
    });
  }
}

/**
 * Create a simple validator that always allows.
 * Useful as a placeholder or for testing.
 */
export function createPassthroughValidator(): NamedValidator {
  return {
    name: 'passthrough',
    description: 'Allows all tool calls without validation',
    priority: 1000, // Run last
    validate: () => ({ decision: 'allow' }),
  };
}

/**
 * Create a validator that denies specific tools.
 *
 * @param toolNames - Names of tools to deny
 * @param reason - Reason for denial
 */
export function createBlocklistValidator(
  toolNames: string[],
  reason = 'Tool is blocked'
): NamedValidator {
  return {
    name: 'blocklist',
    description: `Blocks tools: ${toolNames.join(', ')}`,
    priority: 1, // Run first
    toolFilter: toolNames,
    validate: (context) => ({
      decision: 'deny',
      reason: `${reason}: ${context.toolName}`,
    }),
  };
}

/**
 * Create a validator that only allows specific tools.
 *
 * @param toolNames - Names of tools to allow
 * @param reason - Reason for denial of other tools
 */
export function createAllowlistValidator(
  toolNames: string[],
  reason = 'Tool is not in allowlist'
): NamedValidator {
  const toolSet = new Set(toolNames);
  return {
    name: 'allowlist',
    description: `Only allows tools: ${toolNames.join(', ')}`,
    priority: 1, // Run first
    validate: (context) => {
      if (toolSet.has(context.toolName)) {
        return { decision: 'allow' };
      }
      return {
        decision: 'deny',
        reason: `${reason}: ${context.toolName}`,
      };
    },
  };
}
