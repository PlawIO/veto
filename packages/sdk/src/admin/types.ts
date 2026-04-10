export interface VetoAdminOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

// --- Policies ---

export interface Policy {
  _id: string;
  toolName: string;
  mode: 'deterministic' | 'llm';
  version: number;
  isActive: boolean;
  constraints?: Constraint[];
  outputRules?: OutputRule[];
  llmConfig?: LlmConfig;
  sessionConstraints?: SessionConstraints;
  projectId?: string;
  createdAt: string;
}

export interface Constraint {
  argumentName: string;
  enabled: boolean;
  action?: 'deny' | 'require_approval';
  greaterThan?: number;
  lessThan?: number;
  greaterThanOrEqual?: number;
  lessThanOrEqual?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  regex?: string;
  notRegex?: string;
  enum?: string[];
  notEnum?: string[];
  required?: boolean;
  notNull?: boolean;
  dynamicMinimum?: string;
  dynamicMaximum?: string;
}

export interface OutputRule {
  id: string;
  name: string;
  action: 'block' | 'redact' | 'log';
  tools?: string[];
  output_conditions?: { field: string; operator: string; value: unknown }[];
  redact_with?: string;
}

export interface LlmConfig {
  description: string;
  exceptions: string[];
  argumentInstructions?: { argumentName: string; instruction: string }[];
  preferredModel?: string;
}

export interface SessionConstraints {
  maxCalls?: number;
  spendArgument?: string;
  budget?: number;
  cumulativeLimits?: { argumentName: string; maxValue: number }[];
  counters?: Record<string, {
    increment: string[];
    decrement?: string[];
    max?: number;
    maxAction?: 'deny' | 'require_approval';
  }>;
}

export interface CreatePolicyInput {
  toolName: string;
  projectId?: string;
  mode: 'deterministic' | 'llm';
  constraints?: Constraint[];
  outputRules?: OutputRule[];
  llmConfig?: LlmConfig;
  sessionConstraints?: SessionConstraints;
}

export interface UpdatePolicyInput {
  mode: 'deterministic' | 'llm';
  constraints?: Constraint[];
  outputRules?: OutputRule[];
  llmConfig?: LlmConfig;
  sessionConstraints?: SessionConstraints;
}

// --- Decisions ---

export interface Decision {
  _id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  decision: 'allow' | 'deny' | 'require_approval';
  mode: string;
  reason?: string;
  latencyMs: number;
  createdAt: string;
}

export interface DecisionQuery {
  limit?: number;
  offset?: number;
  projectId?: string;
  toolName?: string;
  decision?: 'allow' | 'deny' | 'require_approval';
  startDate?: string;
  endDate?: string;
}

export interface DecisionStats {
  total: number;
  allowed: number;
  denied: number;
  requireApproval: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// --- Approvals ---

export interface Approval {
  _id: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

// --- Tools ---

export interface Tool {
  _id: string;
  name: string;
  description?: string;
  arguments: Record<string, unknown>[];
}

// --- Policy Drafts ---

export interface PolicyDraft {
  _id: string;
  name: string;
  description?: string;
  status: 'draft' | 'pending_review' | 'approved' | 'rejected';
  createdByAgentId?: string;
  rules: Record<string, unknown>[];
  createdAt: string;
}

export interface CreatePolicyDraftInput {
  name: string;
  description?: string;
  rules: Record<string, unknown>[];
  projectId?: string;
  status?: 'draft' | 'pending_review';
  createdByAgentId?: string;
}

// --- MCP Gateway ---

export interface McpUpstream {
  _id: string;
  slug: string;
  name: string;
  transport: 'mcp-sse' | 'mcp-stdio';
  url?: string;
  command?: string;
  enabled: boolean;
}

export interface CreateUpstreamInput {
  name: string;
  transport: 'mcp-sse' | 'mcp-stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled?: boolean;
  projectId?: string;
}

export interface UpstreamTestResult {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

// --- API Keys ---

export interface ApiKeyInfo {
  _id: string;
  name: string;
  keyPrefix: string;
  isRevoked: boolean;
  projectId?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface ApiKeyCreated {
  _id: string;
  name: string;
  key: string;
  keyPrefix: string;
}

// --- Events ---

export interface VetoAdminEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface EventSubscription {
  unsubscribe: () => void;
}
