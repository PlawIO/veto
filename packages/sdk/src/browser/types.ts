import type {
  LogLevel,
  NamedValidator,
  ValidationContext,
  Validator,
} from '../types/config.js';
import type { OutputRule, Rule, RuleSeverity } from '../rules/types.js';
import type { BudgetConfig, ToolCostMap } from '../core/budget.js';

export type VetoMode = 'strict' | 'log';

export interface GuardContext {
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
}

export interface GuardResult {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  ruleId?: string;
  severity?: RuleSeverity;
  approvalId?: string;
}

export interface BrowserCloudPoliciesResponse {
  policies: Rule[];
  outputRules?: OutputRule[];
}

export interface BrowserCloudDecisionRequest {
  tool_name: string;
  arguments: Record<string, unknown>;
  decision: 'allow' | 'deny';
  reason?: string;
  mode: 'deterministic';
  latency_ms: number;
  source: 'client';
  context?: Record<string, unknown>;
}

export interface BrowserCloudClient {
  fetchPolicies: () => Promise<BrowserCloudPoliciesResponse>;
  logDecision: (request: BrowserCloudDecisionRequest) => void | Promise<void>;
  dispose?: () => void;
}

export interface VetoBrowserOptions<TCloudClient = BrowserCloudClient> {
  rules: Rule[];
  outputRules?: OutputRule[];
  mode?: VetoMode;
  logLevel?: LogLevel;
  sessionId?: string;
  agentId?: string;
  userId?: string;
  role?: string;
  validators?: (Validator | NamedValidator)[];
  apiKey?: string;
  endpoint?: string;
  cloudClient?: TCloudClient;
  onApprovalRequired?: (
    context: ValidationContext,
    approvalId: string
  ) => void | Promise<void>;
  budget?: BudgetConfig;
  costs?: ToolCostMap;
}

export interface VetoFromCloudOptions {
  apiKey: string;
  endpoint?: string;
  refreshIntervalMs?: number;
}
