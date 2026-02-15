/**
 * Veto - A guardrail system for AI agent tool calls.
 *
 * Veto sits between the AI model and tool execution, intercepting and
 * validating tool calls before they are executed.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { Veto, toOpenAITools } from 'veto-sdk';
 *
 * // Initialize Veto
 * const veto = await Veto.init();
 *
 * // Wrap your tools
 * const { definitions, implementations } = veto.wrapTools(myTools);
 *
 * // Pass definitions to AI provider
 * const response = await openai.chat.completions.create({
 *   tools: toOpenAITools(definitions),
 *   messages: [...]
 * });
 *
 * // Execute tool calls using implementations (validation is automatic)
 * for (const call of response.choices[0].message.tool_calls) {
 *   const args = JSON.parse(call.function.arguments);
 *   const result = await implementations[call.function.name](args);
 * }
 * ```
 *
 * @module veto
 */

// Main export
export {
  Veto,
  ToolCallDeniedError,
  type VetoOptions,
  type VetoMode,
  type ValidationMode,
  type WrappedTools,
  type WrappedHandler,
} from './core/veto.js';

// Core types
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolHandler,
  ExecutableTool,
  ToolInputSchema,
  JsonSchemaType,
  JsonSchemaProperty,
} from './types/tool.js';

export type {
  LogLevel,
  ValidationDecision,
  ValidationResult,
  ValidationContext,
  Validator,
  NamedValidator,
  ToolCallHistoryEntry,
} from './types/config.js';

// Rule types
export type {
  Rule,
  RuleSet,
  RuleCondition,
  RuleAction,
  RuleSeverity,
  ValidationAPIResponse,
} from './rules/types.js';

// Custom provider types
export type {
  CustomConfig,
  CustomProvider,
  CustomResponse,
  CustomToolCall,
} from './custom/types.js';
export { CustomClient } from './custom/client.js';

// Cloud types
export type {
  VetoCloudConfig,
  CloudValidationResponse,
  FailedConstraint,
  ApprovalData,
  ApprovalPollOptions,
} from './cloud/types.js';
export { VetoCloudClient, ApprovalTimeoutError } from './cloud/client.js';

// Interception result
export type { InterceptionResult } from './core/interceptor.js';
export type { HistoryStats } from './core/history.js';

// Provider adapters (for converting to/from provider formats)
export {
  toOpenAI,
  fromOpenAI,
  fromOpenAIToolCall,
  toOpenAITools,
  toAnthropic,
  fromAnthropic,
  fromAnthropicToolUse,
  toAnthropicTools,
  toGoogleTool,
  fromGoogleFunctionCall,
} from './providers/adapters.js';

export type {
  OpenAITool,
  OpenAIToolCall,
  AnthropicTool,
  AnthropicToolUse,
  GoogleTool,
  GoogleFunctionCall,
} from './providers/types.js';

// Compiler (AST-based policy expressions)
export { compile, evaluate, typeCheck } from './compiler/index.js';
export type { ASTNode, EvalContext, TypeCheckResult } from './compiler/index.js';

// CLI init function (for programmatic use)
export { init, isInitialized } from './cli/init.js';
