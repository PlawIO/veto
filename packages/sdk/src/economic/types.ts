/**
 * Economic authorization types.
 *
 * Protocol-agnostic types for cost-aware agent authorization
 * across x402, Stripe MPP, Google AP2, and custom protocols.
 *
 * @module economic/types
 */

/**
 * Supported payment protocols.
 */
export type EconomicProtocol = 'x402' | 'mpp' | 'ap2' | 'custom';

/**
 * Normalized economic context produced by protocol connectors.
 *
 * This is the single interface between connectors and the policy engine.
 * Connectors parse protocol-specific responses into this shape;
 * the policy engine evaluates it without knowing which protocol produced it.
 */
export interface EconomicContext {
  /** Resolved cost of this action in the budget currency */
  cost: number;
  /** Currency code (USD, EUR, etc.) */
  currency: string;
  /** Identified payer (wallet address, Stripe customer, mandate signer) */
  payer?: string;
  /** Which payment protocol produced this context */
  protocol: EconomicProtocol;
  /** Protocol-specific metadata (chain, token, mandate ID, session ID, etc.) */
  protocol_metadata?: Record<string, unknown>;
}

/**
 * Denial reason codes for economic authorization failures.
 */
export type EconomicDenialReason =
  | 'budget_exceeded'
  | 'approval_required'
  | 'payer_missing'
  | 'payer_unauthorized'
  | 'currency_mismatch'
  | 'connector_error';

/**
 * Machine-readable details for economic authorization denials.
 *
 * Attached to GuardResult when an economic policy denies a tool call.
 * Enables developers to programmatically handle different denial types.
 */
export interface EconomicDenialDetails {
  reason: EconomicDenialReason;
  cost: number;
  currency: string;
  budget_scope: string;
  budget_limit: number;
  budget_spent: number;
  budget_remaining: number;
  /** The approval threshold that was exceeded (for approval_required denials) */
  approval_threshold?: number;
  payer?: string;
  protocol?: string;
  /** Rendered denial message from template (if configured) */
  message?: string;
  /** Connector name + raw error for connector_error reason */
  connector_name?: string;
  raw_error?: string;
}

/**
 * Budget scope levels.
 *
 * - session: in-memory, SDK-only (LocalBudgetEngine)
 * - agent/user/global: require platform (CloudBudgetEngine via Convex)
 */
export type BudgetScope = 'session' | 'agent' | 'user' | 'global';

/**
 * Budget configuration from policy YAML.
 */
export interface EconomicBudgetConfig {
  scope: BudgetScope;
  limit: number;
  currency: string;
  /** Require approval above this amount (within budget) */
  approval_threshold?: number;
  /** Budget window — 'session' for SDK-only, timed windows require platform */
  window: 'session' | '1h' | '24h' | '30d';
}

/**
 * Cost extraction configuration from policy YAML.
 */
export interface CostExtractionConfig {
  /** Default dot-path to extract cost from tool call context */
  default: string;
  /** Per-tool overrides */
  overrides?: Record<string, string>;
}

/**
 * Payer validation configuration from policy YAML.
 */
export interface PayerConfig {
  /** Block if no payer identified */
  required: boolean;
  /** Optional payer allowlist */
  approved?: string[];
}

/**
 * Custom denial message templates.
 */
export interface DenialReasonTemplates {
  budget_exceeded?: string;
  approval_required?: string;
  payer_missing?: string;
  payer_unauthorized?: string;
}

/**
 * Top-level economic policy configuration from YAML.
 */
export interface EconomicPolicyConfig {
  budgets?: EconomicBudgetConfig[];
  cost_extraction?: CostExtractionConfig;
  payer?: PayerConfig;
  denial_reasons?: DenialReasonTemplates;
}

/**
 * Result of a budget check.
 *
 * Return-based (not throw-based) to compose cleanly with guard() flow.
 */
export interface BudgetCheckResult {
  allowed: boolean;
  decision: 'allow' | 'deny' | 'require_approval';
  denial?: EconomicDenialDetails;
}

/**
 * Current budget status for a scope.
 */
export interface EconomicBudgetStatus {
  scope: BudgetScope;
  spent: number;
  limit: number;
  remaining: number;
  currency: string;
}

/**
 * Budget engine interface.
 *
 * SDK defines the contract; implementations vary by deployment:
 * - LocalBudgetEngine: in-memory, session scope only
 * - CloudBudgetEngine: Convex-backed, all scopes (platform)
 *
 *   BudgetEngine (interface)
 *   ├── LocalBudgetEngine   (SDK, in-memory, session scope only)
 *   └── CloudBudgetEngine   (platform, Convex-backed, all scopes)
 */
export interface BudgetEngine {
  /** Check if a cost is within budget and below approval threshold */
  check(cost: number, currency: string, scope: BudgetScope): BudgetCheckResult;
  /** Reserve budget (atomic check + deduct) */
  reserve(cost: number, currency: string, scope: BudgetScope): BudgetCheckResult;
  /** Record a committed charge */
  record(cost: number, currency: string, scope: BudgetScope): void;
  /** Refund a previously reserved/recorded amount */
  refund(amount: number, scope: BudgetScope): void;
  /** Get current budget status for a scope */
  getStatus(scope: BudgetScope): EconomicBudgetStatus | null;
  /** Reset budget state for a scope */
  reset(scope: BudgetScope): void;
}

/**
 * Protocol connector interface.
 *
 * Connectors parse protocol-specific responses into EconomicContext.
 * Two modes:
 * - extract(): manual — developer calls explicitly (works in any framework)
 * - wrapFetch(): automatic — wraps fetch to auto-detect protocol signals
 */
export interface ProtocolConnector {
  /** Which protocol this connector handles */
  protocol: EconomicProtocol;
  /** Protocol version this connector was built against */
  protocolVersion: string;
  /**
   * Parse a response into economic context (manual/callback mode).
   * Returns null if the response is not a protocol signal.
   */
  extract(response: Response | Record<string, unknown>): EconomicContext | null;
  /**
   * Wrap a fetch function to auto-detect protocol signals (auto mode).
   * Optional — not all connectors support auto-wrapping.
   */
  wrapFetch?(fetchFn: typeof fetch): typeof fetch;
}

/**
 * Economic webhook event types (extends base webhook events).
 */
export type EconomicWebhookEventType =
  | 'budget_warning'
  | 'approval_triggered'
  | 'spend_committed'
  | 'protocol_detected';
