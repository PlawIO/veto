/**
 * Veto - Policy runtime for AI agent tool calls.
 *
 * Veto sits between the AI model and tool execution, intercepting and
 * validating tool calls before they are executed.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { protect } from 'veto-sdk';
 *
 * // Protect your tools in one call. Local ./veto rules are loaded when present;
 * // otherwise zero-config safe defaults run in observe mode.
 * const safeTools = await protect(myTools);
 *
 * // Pass safeTools to your agent. Tool interfaces and types are preserved.
 * const agent = createAgent({ tools: safeTools });
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
export {
  protect,
  type ProtectOptions,
  type ProtectMode,
} from './core/protect.js';

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
  StreamLogMode,
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
  RateLimitEntry,
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
  SessionState,
} from './cloud/types.js';

// Deterministic constraint types
export type {
  ArgumentConstraint,
  SessionConstraints,
  SessionCounterConfig,
  CumulativeLimit,
  DeterministicPolicy,
  LocalValidationResult,
} from './deterministic/types.js';
export { VetoCloudClient, ApprovalTimeoutError } from './cloud/client.js';

// Interception result
export type { InterceptionResult, DenialDetails } from './core/interceptor.js';
export type { HistoryStats } from './core/history.js';
export type { OutputValidationResult } from './core/output-validator.js';
export type {
  EventWebhookConfig,
  VetoWebhookEvent,
  VetoWebhookEventType,
  VetoWebhookFormat,
} from './core/events.js';
export {
  formatSlackPayload,
  formatPagerDutyPayload,
  formatGenericPayload,
  formatCefPayload,
  resolveEventWebhookConfig,
} from './core/events.js';

// Budget (legacy — use economic module for new code)
export {
  BudgetTracker,
  BudgetExceededError,
  type BudgetConfig,
  type ToolCostMap,
  type BudgetStatus,
} from './core/budget.js';

// Economic authorization (x402, MPP, AP2)
export {
  LocalBudgetEngine,
  EconomicEvaluator,
  createX402Connector,
  createMPPConnector,
  createAP2Connector,
  buildX402ConnectorError,
  buildMPPConnectorError,
  buildAP2ConnectorError,
} from './economic/index.js';
export type {
  EconomicContext,
  EconomicDenialDetails,
  EconomicDenialReason,
  EconomicProtocol,
  BudgetEngine,
  BudgetCheckResult,
  BudgetScope,
  EconomicBudgetStatus,
  EconomicPolicyConfig,
  EconomicBudgetConfig,
  CostExtractionConfig,
  PayerConfig,
  ProtocolConnector,
  EconomicWebhookEventType,
} from './economic/index.js';

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
  extractMCPEconomicContext,
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

// Content extractors
export {
  extractEntities,
  type ExtractedEntities,
  type ExtractEntitiesOptions,
} from './extractors/content.js';

// Local rule evaluator
export {
  evaluateRulesLocally,
  evaluateCondition as evaluateConditionLocally,
  resolveFieldPath as resolveLocalFieldPath,
  type LocalEvalResult,
} from './rules/local-evaluator.js';

// Policy generator utilities
export {
  BROWSER_AGENT_SYSTEM_PROMPT,
  getPolicyOutputSchema,
  sanitizeGeneratedRules,
  validatePolicyOutput,
  tryInstantGeneration,
  looksLikePolicyDeclaration,
  reviewPolicyRequest,
  type PolicyGenerationResult,
  type PolicyClarificationRequest,
} from './policy/generator.js';

// Rate limiting
export type { RateLimitStore } from './rate-limiting/evaluator.js';
export { RedisRateLimitStore } from './rate-limiting/redis-store.js';

// Audit chain
export { computeChainHash, GENESIS_HASH } from './audit/chain.js';

// Observability
export { tryLoadOtel, SpanStatusCode } from './observability/otel.js';
export type { VetoTracer, VetoSpan } from './observability/otel.js';

// Testing
export { runTests } from './testing/runner.js';
export type { RunTestsOptions } from './testing/runner.js';
export type {
  VetoTestCase,
  VetoTestSuite,
  VetoTestResult,
  VetoTestRunResult,
} from './testing/types.js';

// CLI init function (for programmatic use)
export { init, isInitialized } from './cli/init.js';

// Admin management client
export { VetoAdmin, VetoAdminError } from './admin/client.js';
export type {
  VetoAdminOptions,
  Policy,
  Constraint,
  OutputRule as AdminOutputRule,
  LlmConfig,
  SessionConstraints as AdminSessionConstraints,
  CreatePolicyInput,
  UpdatePolicyInput,
  Decision,
  DecisionQuery,
  DecisionStats,
  PaginatedResult,
  Approval,
  Tool as AdminTool,
  PolicyDraft,
  CreatePolicyDraftInput,
  McpUpstream,
  CreateUpstreamInput,
  UpstreamTestResult,
  ApiKeyInfo,
  ApiKeyCreated,
  VetoAdminEvent,
  EventSubscription,
} from './admin/types.js';
