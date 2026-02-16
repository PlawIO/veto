/**
 * Type definitions for YAML-based rules.
 *
 * Rules define restrictions on tools and agent behavior. They are loaded
 * from YAML files and used to validate tool calls via an external API.
 *
 * @module rules/types
 */

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
  | 'less_than'
  | 'in'
  | 'not_in';

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
  /** AST-compiled policy expression (takes precedence over field/operator/value) */
  expression?: string;
}

/**
 * Action to take when a rule matches.
 */
export type RuleAction = 'block' | 'warn' | 'log' | 'allow' | 'require_approval';

/**
 * Severity level for a rule.
 */
export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

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
  /** Whether the rule is enabled */
  enabled: boolean;
  /** Severity level */
  severity: RuleSeverity;
  /** Default action when conditions match */
  action: RuleAction;
  /** Tools this rule applies to (empty = all tools) */
  tools?: string[];
  /** Conditions that must be met for the rule to trigger (AND logic) */
  conditions?: RuleCondition[];
  /** Alternative condition groups (OR logic between groups) */
  condition_groups?: RuleCondition[][];
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
  /** Rules in this set */
  rules: Rule[];
  /** Global settings for this rule set */
  settings?: RuleSetSettings;
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
  /** Rules indexed by tool name for quick lookup */
  rulesByTool: Map<string, Rule[]>;
  /** Global rules that apply to all tools */
  globalRules: Rule[];
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
