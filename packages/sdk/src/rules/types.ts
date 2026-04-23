/**
 * Type definitions for YAML-based rules.
 *
 * Rules define restrictions on tools and agent behavior. They are loaded
 * from YAML files and used to validate tool calls via an external API.
 *
 * @module rules/types
 */

import type { SessionConstraints } from '../deterministic/types.js';
import type { EconomicPolicyConfig } from '../economic/types.js';
import type { RateLimitEntry } from '../rate-limiting/types.js';
export type { RateLimitEntry };

/**
 * Condition operators for rule matching.
 */
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches'  // Regex match
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'percent_of'
  | 'length_greater_than'
  | 'in'
  | 'not_in'
  | 'not_exists'
  | 'outside_hours'
  | 'within_hours';

/**
 * Supported day abbreviations for time-based conditions.
 */
export type TimeConditionDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * Value shape used by `within_hours` and `outside_hours`.
 */
export interface TimeWindowConditionValue {
  /** Start time in 24h HH:MM format. */
  start: string;
  /** End time in 24h HH:MM format. */
  end: string;
  /** IANA timezone identifier. */
  timezone: string;
  /** Optional allowed day filters. If omitted, applies every day. */
  days?: TimeConditionDay[];
}

/**
 * Behavior when a feed snapshot is missing or stale.
 *
 * - `fail_open`: treat as unmatched (rule does not trigger). Use when the
 *   rule is a block-list and availability matters more than precision.
 * - `fail_closed`: treat as matched (rule triggers). Use when the rule is
 *   an allow-list and missing data must not silently permit.
 * - `last_known_good`: use the most recent snapshot irrespective of age.
 *   The provider is responsible for holding the last snapshot; the
 *   evaluator only distinguishes "snapshot present" vs "absent".
 */
export type FeedFallback = 'fail_open' | 'fail_closed' | 'last_known_good';

/**
 * Condition value referencing a dynamic pipeline feed.
 *
 * The comparand is resolved at evaluation time from a FeedProvider.
 * Used with set-membership operators (`in`, `not_in`, `contains`,
 * `not_contains`).
 */
export interface FeedConditionValue {
  kind: 'feed';
  /** Content-addressable pipeline/feed identifier. */
  feed_id: string;
  /** Version pinning: semver, `"latest"`, or `"pinned"` (immutable). */
  version: string | 'latest' | 'pinned';
  /** Max age in seconds before the snapshot is considered stale. */
  max_staleness_sec: number;
  /** Behavior on missing or stale snapshot. */
  fallback: FeedFallback;
}

/**
 * Condition value referencing a pipeline by id. Equivalent to a FeedRef
 * whose feed_id is the pipeline's content hash — kept as a distinct
 * variant so compilers can emit either shape depending on whether the
 * policy references the pipeline itself or a downstream feed.
 */
export interface PipelineConditionValue {
  kind: 'pipeline';
  pipeline_id: string;
  version: string | 'latest' | 'pinned';
  max_staleness_sec: number;
  fallback: FeedFallback;
}

/**
 * Union of the typed condition-value variants. A literal value in
 * `RuleCondition.value` is not wrapped; only references are tagged.
 * Use `isConditionValueRef(v)` at runtime to narrow.
 */
export type ConditionValueRef = FeedConditionValue | PipelineConditionValue;

/**
 * Runtime narrowing guard for typed condition-value references.
 *
 * Returns true when `value` is a tagged FeedRef or PipelineRef.
 * Literal values, arrays, TimeWindowConditionValue, and other plain
 * objects return false and are treated as bare comparands.
 */
export function isConditionValueRef(value: unknown): value is ConditionValueRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'feed' || kind === 'pipeline';
}

/**
 * Snapshot returned by a FeedProvider.
 */
export interface FeedSnapshot {
  /** Resolved snapshot data — usually a list of strings or objects. */
  data: unknown[];
  /** Unix ms timestamp when the snapshot was produced upstream. */
  refreshed_at_ms: number;
  /** Semver or content-hash version of the producing pipeline spec. */
  version?: string;
}

/**
 * Read-only feed-snapshot provider injected into the local evaluator.
 *
 * Intentionally synchronous: the evaluator must remain sub-millisecond.
 * Async refresh is the caller's responsibility — the provider should
 * hand back the most recent pre-fetched snapshot or `undefined`.
 */
export interface FeedProvider {
  get(feedId: string, version?: string): FeedSnapshot | undefined;
}

/**
 * A single condition within a rule.
 *
 * Conditions can be specified in two ways:
 * 1. Legacy: field + operator + value (simple comparisons)
 * 2. Expression: a compiled policy expression string (AST-based)
 *
 * When `expression` is set, `field`, `operator`, and `value` are ignored.
 */
export interface RuleCondition {
  /** The field to check (supports dot notation, e.g., "arguments.path") */
  field?: string;
  /** The operator to use for comparison */
  operator?: ConditionOperator;
  /** The value to compare against */
  value?: unknown;
  /** Reference field used by dynamic operators such as `percent_of` */
  reference?: string;
  /** AST-compiled policy expression (takes precedence over field/operator/value) */
  expression?: string;
}

/**
 * Cross-tool sequence constraint for matching historical calls.
 */
export interface RuleSequenceConstraint {
  /** Historical tool name to search for */
  tool: string;
  /** Conditions that must all match on the historical call context (AND logic) */
  conditions?: RuleCondition[];
  /** Alternative condition groups (OR logic between groups) */
  condition_groups?: RuleCondition[][];
  /** Optional time window in seconds (relative to the current call) */
  within?: number;
}

/**
 * Action to take when a rule matches.
 */
export type RuleAction = 'block' | 'warn' | 'log' | 'allow' | 'require_approval' | 'require_payment';

/**
 * Payment configuration for the `require_payment` action.
 */
export interface PaymentConfig {
  /** Payment protocol: x402 (EVM L2), mpp (Stripe), or ap2 (Google) */
  protocol: 'x402' | 'mpp' | 'ap2';
  /** Amount to charge */
  amount: number;
  /** Currency code (e.g. USDC, USD) */
  currency: string;
  /** Chain ID for EVM-based protocols (e.g. 8453 for Base) */
  chain_id?: number;
}

/**
 * Action to take when an output rule matches.
 */
export type OutputRuleAction = 'block' | 'redact' | 'log';

/**
 * Severity level for a rule.
 */
export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Agent scoping for rule applicability.
 * - string[]: include-only list
 * - { not: string[] }: exclude list
 */
export type RuleAgentsScope = string[] | { not: string[] };

/**
 * A single rule definition.
 */
export interface Rule {
  /** Unique identifier for the rule */
  id: string;
  /** Human-readable name */
  name: string;
  /** Detailed description of what the rule does */
  description?: string;
  /** Optional user-facing message for approvals, warnings, or denials */
  message?: string;
  /** Whether the rule is enabled */
  enabled: boolean;
  /** Severity level */
  severity: RuleSeverity;
  /** Default action when conditions match */
  action: RuleAction;
  /** Tools this rule applies to (empty = all tools) */
  tools?: string[];
  /** Optional agent scope for this rule */
  agents?: RuleAgentsScope;
  /** Conditions that must be met for the rule to trigger (AND logic) */
  conditions?: RuleCondition[];
  /** Alternative condition groups (OR logic between groups) */
  condition_groups?: RuleCondition[][];
  /** Trigger this rule if any matching historical call exists */
  blocked_by?: RuleSequenceConstraint[];
  /** Trigger this rule when any required historical call is missing */
  requires?: RuleSequenceConstraint[];
  /** Tags for categorization */
  tags?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Dynamic sliding-window rate limits evaluated after conditions pass. */
  rate_limits?: RateLimitEntry[];
  /** Payment gate configuration for `require_payment` action. */
  payment?: PaymentConfig;
}

/**
 * A single output rule definition.
 */
export interface OutputRule {
  /** Unique identifier for this output rule */
  id: string;
  /** Human-readable name */
  name: string;
  /** Detailed description of what this output rule does */
  description?: string;
  /** Whether this output rule is enabled */
  enabled: boolean;
  /** Severity level */
  severity: RuleSeverity;
  /** Action to take when conditions match */
  action: OutputRuleAction;
  /** Tools this output rule applies to (empty = all tools) */
  tools?: string[];
  /** Conditions that must be met for the output rule to trigger (AND logic) */
  output_conditions?: RuleCondition[];
  /** Alternative condition groups (OR logic between groups) */
  output_condition_groups?: RuleCondition[][];
  /** Replacement text for redact action */
  redact_with?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * A rule set containing multiple rules with shared configuration.
 */
export interface RuleSet {
  /** Version of the rule set format */
  version: string;
  /** Name of the rule set */
  name: string;
  /** Description of the rule set */
  description?: string;
  /** Optional built-in policy pack this rule set extends */
  extends?: string;
  /** Rules in this set */
  rules: Rule[];
  /** Output rules in this set */
  output_rules?: OutputRule[];
  /** Global settings for this rule set */
  settings?: RuleSetSettings;
  /** Economic authorization settings for this rule set */
  economic?: EconomicPolicyConfig;
  /** Session-level constraints for this rule set */
  sessionConstraints?: SessionConstraints;
}

/**
 * Global settings for a rule set.
 */
export interface RuleSetSettings {
  /** Default action when no rules match */
  default_action?: RuleAction;
  /** Whether to fail open (allow) or closed (block) on errors */
  fail_mode?: 'open' | 'closed';
  /** Tags to apply to all rules in this set */
  global_tags?: string[];
}

/**
 * Context passed to the validation API.
 */
export interface ToolCallContext {
  /** Unique identifier for this tool call */
  call_id: string;
  /** Name of the tool being called */
  tool_name: string;
  /** Arguments passed to the tool */
  arguments: Record<string, unknown>;
  /** Timestamp of the call */
  timestamp: string;
  /** Session or conversation ID (if available) */
  session_id?: string;
  /** User or agent ID (if available) */
  agent_id?: string;
  /** User ID (if available) */
  user_id?: string;
  /** Role (if available) */
  role?: string;
  /** Previous tool calls in this session */
  call_history?: ToolCallHistorySummary[];
  /** Custom context data */
  custom?: Record<string, unknown>;
}

/**
 * Summary of a previous tool call for history context.
 */
export interface ToolCallHistorySummary {
  /** Tool name */
  tool_name: string;
  /** Whether it was allowed */
  allowed: boolean;
  /** Timestamp */
  timestamp: string;
}

/**
 * Request payload sent to the validation API.
 */
export interface ValidationAPIRequest {
  /** The tool call context */
  context: ToolCallContext;
  /** Rules applicable to this tool call */
  rules: Rule[];
}

/**
 * Response from the validation API.
 */
export interface ValidationAPIResponse {
  /** Weight indicating confidence that the call should pass (0.0 - 1.0) */
  should_pass_weight: number;
  /** Weight indicating confidence that the call should be blocked (0.0 - 1.0) */
  should_block_weight: number;
  /** Final decision */
  decision: 'pass' | 'block';
  /** Human-readable reasoning for the decision */
  reasoning: string;
  /** Optional: IDs of rules that matched */
  matched_rules?: string[];
  /** Optional: Additional metadata from the API */
  metadata?: Record<string, unknown>;
}

/**
 * Loaded rules with their source information.
 */
export interface LoadedRules {
  /** All loaded rule sets */
  ruleSets: RuleSet[];
  /** All rules flattened from rule sets */
  allRules: Rule[];
  /** All output rules flattened from rule sets */
  allOutputRules: OutputRule[];
  /** Rules indexed by tool name for quick lookup */
  rulesByTool: Map<string, Rule[]>;
  /** Output rules indexed by tool name for quick lookup */
  outputRulesByTool: Map<string, OutputRule[]>;
  /** Global rules that apply to all tools */
  globalRules: Rule[];
  /** Global output rules that apply to all tools */
  globalOutputRules: OutputRule[];
  /** Source files that were loaded */
  sourceFiles: string[];
}

/**
 * Get rules applicable to a specific tool.
 */
export function getRulesForTool(
  loadedRules: LoadedRules,
  toolName: string
): Rule[] {
  const toolSpecific = loadedRules.rulesByTool.get(toolName) ?? [];
  return [...loadedRules.globalRules, ...toolSpecific].filter(
    (rule) => rule.enabled
  );
}

/**
 * Get output rules applicable to a specific tool.
 */
export function getOutputRulesForTool(
  loadedRules: LoadedRules,
  toolName: string
): OutputRule[] {
  const toolSpecific = loadedRules.outputRulesByTool.get(toolName) ?? [];
  return [...loadedRules.globalOutputRules, ...toolSpecific].filter(
    (rule) => rule.enabled
  );
}
