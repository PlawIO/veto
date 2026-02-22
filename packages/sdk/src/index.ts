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
  type GuardContext,
  type GuardResult,
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
  DecisionExportFormat,
  DecisionExportRecord,
} from './types/config.js';

// Rule types
export type {
  Rule,
  RuleSet,
  RuleCondition,
  RuleAgentsScope,
  RuleAction,
  OutputRule,
  OutputRuleAction,
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
export type { OutputValidationResult } from './core/output-validator.js';

// Budget
export {
  BudgetTracker,
  BudgetExceededError,
  type BudgetConfig,
  type ToolCostMap,
  type BudgetStatus,
} from './core/budget.js';

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
  toMCP,
  fromMCP,
  fromMCPToolCall,
  toMCPTools,
  isMCPTool,
} from './providers/adapters.js';

export type {
  OpenAITool,
  OpenAIToolCall,
  AnthropicTool,
  AnthropicToolUse,
  GoogleTool,
  GoogleFunctionCall,
  MCPTool,
  MCPToolCallArgs,
  MCPToolResult,
  MCPServerClient,
} from './providers/types.js';

// Compiler (AST-based policy expressions)
export { compile, evaluate, typeCheck } from './compiler/index.js';
export type { ASTNode, EvalContext, TypeCheckResult } from './compiler/index.js';

// Common output redaction patterns (reference only, not auto-applied)
export {
  OUTPUT_PATTERNS,
  OUTPUT_PATTERN_SSN,
  OUTPUT_PATTERN_CREDIT_CARD,
  OUTPUT_PATTERN_OPENAI_API_KEY,
  OUTPUT_PATTERN_GITHUB_API_KEY,
  OUTPUT_PATTERN_AWS_API_KEY,
  OUTPUT_PATTERN_EMAIL,
  OUTPUT_PATTERN_US_PHONE,
} from './rules/patterns.js';

// CLI init function (for programmatic use)
export { init, isInitialized } from './cli/init.js';
