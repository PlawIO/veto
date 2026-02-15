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
}

export interface DeterministicPolicy {
  toolName: string;
  mode: 'deterministic' | 'llm';
  constraints: ArgumentConstraint[];
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
