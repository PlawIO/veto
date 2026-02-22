/**
 * Tool call interceptor.
 *
 * This module handles intercepting tool calls from the AI model
 * and routing them through the validation pipeline.
 *
 * @module core/interceptor
 */

import type {
  ToolCall,
  ToolResult,
  ExecutableTool,
} from '../types/tool.js';
import type {
  ValidationContext,
  ValidationResult,
} from '../types/config.js';
import type { Logger } from '../utils/logger.js';
import type { ValidationEngine, AggregatedValidationResult } from './validator.js';
import type { HistoryTracker } from './history.js';
import type { BudgetTracker } from './budget.js';
import { generateToolCallId } from '../utils/id.js';
import type { OutputValidationResult } from './output-validator.js';

interface OutputValidationEngine {
  validate: (
    toolName: string,
    output: unknown
  ) => OutputValidationResult | Promise<OutputValidationResult>;
}

/**
 * Options for the interceptor.
 */
export interface InterceptorOptions {
  /** Logger instance */
  logger: Logger;
  /** Validation engine */
  validationEngine: ValidationEngine;
  /** History tracker (optional) */
  historyTracker?: HistoryTracker;
  /** Budget tracker (optional) */
  budgetTracker?: BudgetTracker;
  /** Custom context data for validators */
  customContext?: Record<string, unknown>;
  /** Hook called before validation */
  onBeforeValidation?: (context: ValidationContext) => void | Promise<void>;
  /** Hook called after validation */
  onAfterValidation?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
  /** Hook called when a call is denied */
  onDenied?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
  /** Optional output validator for post-execution output checks */
  outputValidator?: OutputValidationEngine;
}

/**
 * Result of intercepting a tool call.
 */
export interface InterceptionResult {
  /** Whether the call was allowed */
  allowed: boolean;
  /** The validation result */
  validationResult: ValidationResult;
  /** Aggregated results from all validators */
  aggregatedResult: AggregatedValidationResult;
  /** The original tool call */
  originalCall: ToolCall;
  /** The potentially modified arguments */
  finalArguments: Record<string, unknown>;
}

/**
 * Error thrown when a tool call is denied.
 */
export class ToolCallDeniedError extends Error {
  readonly toolName: string;
  readonly callId: string;
  readonly reason: string;
  readonly validationResult: ValidationResult;

  constructor(
    toolName: string,
    callId: string,
    validationResult: ValidationResult
  ) {
    const reason = validationResult.reason ?? 'Tool call denied';
    super(`Tool call denied: ${toolName} - ${reason}`);
    this.name = 'ToolCallDeniedError';
    this.toolName = toolName;
    this.callId = callId;
    this.reason = reason;
    this.validationResult = validationResult;
  }
}

/**
 * Tool call interceptor that routes calls through validation.
 */
export class Interceptor {
  private readonly logger: Logger;
  private readonly validationEngine: ValidationEngine;
  private readonly historyTracker?: HistoryTracker;
  private readonly budgetTracker?: BudgetTracker;
  private readonly customContext?: Record<string, unknown>;
  private readonly onBeforeValidation?: (
    context: ValidationContext
  ) => void | Promise<void>;
  private readonly onAfterValidation?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
  private readonly onDenied?: (
    context: ValidationContext,
    result: ValidationResult
  ) => void | Promise<void>;
  private readonly outputValidator?: OutputValidationEngine;

  constructor(options: InterceptorOptions) {
    this.logger = options.logger;
    this.validationEngine = options.validationEngine;
    this.historyTracker = options.historyTracker;
    this.budgetTracker = options.budgetTracker;
    this.customContext = options.customContext;
    this.onBeforeValidation = options.onBeforeValidation;
    this.onAfterValidation = options.onAfterValidation;
    this.onDenied = options.onDenied;
    this.outputValidator = options.outputValidator;
  }

  /**
   * Intercept and validate a tool call.
   *
   * @param call - The tool call to intercept
   * @returns The interception result
   */
  async intercept(call: ToolCall): Promise<InterceptionResult> {
    const callId = call.id || generateToolCallId();

    this.logger.info('Intercepting tool call', {
      toolName: call.name,
      callId,
    });

    // Build validation context
    const context: ValidationContext = {
      toolName: call.name,
      arguments: call.arguments,
      callId,
      timestamp: new Date(),
      callHistory: this.historyTracker?.getAll() ?? [],
      source: 'interceptor',
      custom: this.customContext,
    };

    // Atomically reserve budget (check + deduct in one step to prevent
    // concurrent calls from passing the check before any charge is recorded)
    let reservedCost = 0;
    if (this.budgetTracker) {
      reservedCost = this.budgetTracker.reserve(call.name, call.arguments);
    }

    // Run before hook
    if (this.onBeforeValidation) {
      try {
        await this.onBeforeValidation(context);
      } catch (error) {
        this.logger.warn('onBeforeValidation hook threw an error', {
          callId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Run validation
    let aggregatedResult: Awaited<ReturnType<ValidationEngine['validate']>>;
    try {
      aggregatedResult = await this.validationEngine.validate(context);
    } catch (error) {
      // Refund reserved budget if validation throws
      if (this.budgetTracker && reservedCost > 0) {
        this.budgetTracker.refund(reservedCost);
      }
      throw error;
    }
    const validationResult = aggregatedResult.finalResult;

    // Determine final arguments (may be modified by validators)
    const finalArguments =
      validationResult.decision === 'modify' && validationResult.modifiedArguments
        ? validationResult.modifiedArguments
        : call.arguments;

    // Record in history
    if (this.historyTracker) {
      this.historyTracker.record(
        call.name,
        call.arguments,
        validationResult,
        aggregatedResult.totalDurationMs
      );
    }

    // Run after hook
    if (this.onAfterValidation) {
      try {
        await this.onAfterValidation(context, validationResult);
      } catch (error) {
        this.logger.warn('onAfterValidation hook threw an error', {
          callId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Refund reserved budget for denied calls
    if (this.budgetTracker && validationResult.decision === 'deny' && reservedCost > 0) {
      this.budgetTracker.refund(reservedCost);
    }

    // Handle denial
    if (validationResult.decision === 'deny') {
      if (this.onDenied) {
        try {
          await this.onDenied(context, validationResult);
        } catch (error) {
          this.logger.warn('onDenied hook threw an error', {
            callId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.logger.warn('Tool call denied', {
        toolName: call.name,
        callId,
        reason: validationResult.reason,
      });
    } else {
      this.logger.info('Tool call allowed', {
        toolName: call.name,
        callId,
        decision: validationResult.decision,
        wasModified: validationResult.decision === 'modify',
      });
    }

    return {
      allowed: validationResult.decision !== 'deny',
      validationResult,
      aggregatedResult,
      originalCall: call,
      finalArguments,
    };
  }

  /**
   * Intercept a tool call and throw if denied.
   *
   * @param call - The tool call to intercept
   * @returns The interception result (only if allowed)
   * @throws {ToolCallDeniedError} If the call is denied
   */
  async interceptOrThrow(call: ToolCall): Promise<InterceptionResult> {
    const result = await this.intercept(call);

    if (!result.allowed) {
      throw new ToolCallDeniedError(
        call.name,
        call.id || 'unknown',
        result.validationResult
      );
    }

    return result;
  }

  /**
   * Intercept and execute a tool call.
   *
   * If the call is allowed and the tool has a handler, executes the handler.
   *
   * @param call - The tool call to execute
   * @param tools - Available tools with handlers
   * @returns The tool result
   */
  async interceptAndExecute(
    call: ToolCall,
    tools: readonly ExecutableTool[]
  ): Promise<ToolResult> {
    const result = await this.intercept(call);

    if (!result.allowed) {
      return {
        toolCallId: call.id || generateToolCallId(),
        toolName: call.name,
        content: {
          error: 'Tool call denied',
          reason: result.validationResult.reason,
        },
        isError: true,
      };
    }

    // Find the tool
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      this.logger.error('Tool not found for execution', {
        toolName: call.name,
        availableTools: tools.map((t) => t.name),
      });
      return {
        toolCallId: call.id || generateToolCallId(),
        toolName: call.name,
        content: {
          error: 'Tool not found',
          message: `No tool named "${call.name}" is registered`,
        },
        isError: true,
      };
    }

    // Execute the tool
    const startTime = performance.now();
    try {
      const content = await tool.handler(result.finalArguments);
      const durationMs = performance.now() - startTime;

      let finalContent = content;
      if (this.outputValidator) {
        const outputResult = await this.outputValidator.validate(call.name, content);

        if (outputResult.decision === 'block') {
          this.logger.warn('Tool output blocked', {
            toolName: call.name,
            reason: outputResult.reason,
            matchedRuleIds: outputResult.matchedRuleIds,
          });

          return {
            toolCallId: call.id || generateToolCallId(),
            toolName: call.name,
            content: {
              error: 'Tool output blocked',
              reason: outputResult.reason,
            },
            isError: true,
          };
        }

        finalContent = outputResult.output;
      }

      this.logger.debug('Tool executed successfully', {
        toolName: call.name,
        durationMs: Math.round(durationMs * 100) / 100,
      });

      return {
        toolCallId: call.id || generateToolCallId(),
        toolName: call.name,
        content: finalContent,
        isError: false,
      };
    } catch (error) {
      const durationMs = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        'Tool execution failed',
        {
          toolName: call.name,
          durationMs: Math.round(durationMs * 100) / 100,
        },
        error instanceof Error ? error : new Error(errorMessage)
      );

      return {
        toolCallId: call.id || generateToolCallId(),
        toolName: call.name,
        content: {
          error: 'Tool execution failed',
          message: errorMessage,
        },
        isError: true,
      };
    }
  }
}
