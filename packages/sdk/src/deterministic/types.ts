export interface ArgumentConstraint {
  argumentName: string;
  enabled: boolean;
  greaterThan?: number;
  lessThan?: number;
  greaterThanOrEqual?: number;
  lessThanOrEqual?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  regex?: string;
  enum?: string[];
  in?: unknown[];
  notIn?: unknown[];
  minItems?: number;
  maxItems?: number;
  required?: boolean;
  notNull?: boolean;

  /**
   * Dynamic minimum — an arithmetic expression evaluated at runtime against
   * session state. Example: `"session.remaining * 0.10"`
   *
   * Available variables:
   *   - `session.budget` — declared session budget
   *   - `session.spent` — cumulative spend so far
   *   - `session.remaining` — budget minus spent
   *   - `session.counter.<name>` — named session counter value
   *   - `args.<name>` — value of another argument in the current call
   *
   * Operators: `+`, `-`, `*`, `/`, `%`, parentheses.
   * If both `minimum` and `dynamicMinimum` are set, the more restrictive wins.
   * Expression evaluation failure = fail closed (deny).
   */
  dynamicMinimum?: string;

  /**
   * Dynamic maximum — an arithmetic expression evaluated at runtime against
   * session state. Example: `"session.remaining * 0.15"`
   *
   * Same variable/operator support as `dynamicMinimum`.
   * If both `maximum` and `dynamicMaximum` are set, the more restrictive wins.
   */
  dynamicMaximum?: string;
}

/**
 * Configuration for a named session counter.
 *
 * Counters track a numeric value across tool calls in a session.
 * They can be used for position tracking, concurrency limits,
 * rate limiting, or any countable resource.
 *
 * @example
 * ```yaml
 * counters:
 *   open_positions:
 *     increment: [buy_shares]
 *     decrement: [sell_shares]
 *     max: 3
 *     maxAction: require_approval
 *   api_calls:
 *     increment: [call_external_api]
 *     max: 100
 *     maxAction: deny
 * ```
 */
export interface SessionCounterConfig {
  /** Tool names that increment this counter on allow */
  increment: string[];
  /** Tool names that decrement this counter on allow */
  decrement?: string[];
  /** Maximum value — triggers `maxAction` when reached */
  max?: number;
  /** Action when counter reaches max: "deny" (hard block) or "require_approval" (HITL) */
  maxAction?: 'deny' | 'require_approval';
}

/**
 * Session-level constraints applied across multiple tool calls.
 *
 * @example
 * ```yaml
 * sessionConstraints:
 *   budget: 500
 *   cumulativeLimits:
 *     - argumentName: amount_usd
 *       maxValue: 500
 *   counters:
 *     open_positions:
 *       increment: [buy_shares]
 *       decrement: [sell_shares]
 *       max: 3
 *       maxAction: require_approval
 * ```
 */
export interface SessionConstraints {
  /** Maximum number of calls to a single tool per session */
  maxCalls?: number;

  /**
   * Cumulative argument limits — sums a numeric argument across calls
   * and denies when the total exceeds `maxValue`.
   */
  cumulativeLimits?: CumulativeLimit[];

  /**
   * Session budget — the total spend allowed in this session.
   * Tracked via the first `cumulativeLimits` argument.
   * Available in dynamic expressions as `session.budget`, `session.spent`,
   * and `session.remaining`.
   */
  budget?: number;

  /**
   * Named counters — generic counters that increment/decrement
   * based on which tools are called. Use for position tracking,
   * concurrency limits, rate limiting, etc.
   *
   * Counter values are available in dynamic expressions as
   * `session.counter.<name>`.
   */
  counters?: Record<string, SessionCounterConfig>;
}

export interface CumulativeLimit {
  argumentName: string;
  maxValue: number;
}

export interface DeterministicPolicy {
  toolName: string;
  mode: 'deterministic' | 'llm';
  constraints: ArgumentConstraint[];
  sessionConstraints?: SessionConstraints;
  hasSessionConstraints: boolean;
  hasRateLimits: boolean;
  version: number;
  fetchedAt: number;
}

export interface LocalValidationResult {
  decision: 'allow' | 'deny';
  reason?: string;
  failedArgument?: string;
  validations?: { argument: string; status: 'pass' | 'fail'; reason?: string }[];
  latencyMs: number;
}

interface ConstraintCheckResult {
  pass: boolean;
  reason?: string;
}

export type { ConstraintCheckResult };
