/**
 * Type definitions for Veto Cloud API interactions.
 *
 * @module cloud/types
 */

import type { ArgumentConstraint, SessionConstraints } from '../deterministic/types.js';
import type { OutputRuleLiftTrace, RedactionTrace } from '../core/output-validator.js';
import type { Rule, OutputRule } from '../rules/types.js';
import type { ReceiptSummary } from 'veto-receipt-protocol';

/**
 * Configuration for the Veto Cloud client.
 */
export interface VetoCloudConfig {
  /** API key for authentication (sent as X-Veto-API-Key header) */
  apiKey?: string;
  /** Base URL of the Veto Cloud API */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Number of retries on failure */
  retries?: number;
  /** Delay between retries in milliseconds */
  retryDelay?: number;
}

/**
 * Resolved cloud configuration with defaults applied.
 */
export interface ResolvedCloudConfig {
  apiKey?: string;
  baseUrl: string;
  timeout: number;
  retries: number;
  retryDelay: number;
}

/**
 * Tool parameter definition for cloud registration.
 */
export interface CloudToolParameter {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

/**
 * Tool registration payload.
 */
export interface CloudToolRegistration {
  name: string;
  description?: string;
  parameters: CloudToolParameter[];
}

/**
 * Response from tool registration.
 */
export interface CloudToolRegistrationResponse {
  success: boolean;
  registered_tools: string[];
  message?: string;
}

/**
 * Details about a constraint that failed validation.
 */
export interface FailedConstraint {
  parameter: string;
  constraint_type: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

/**
 * Structured denial details returned by the server on deny/require_approval.
 */
export interface CloudDenialDetails {
  policyId?: string;
  policyName?: string;
  severity: 'deny' | 'require_approval';
  matchedCondition?: string;
  suggestedFixes: string[];
  docsUrl?: string;
  input?: Record<string, unknown>;
}

/**
 * Response from cloud tool call validation.
 */
export interface CloudValidationResponse {
  decision: 'allow' | 'deny' | 'require_approval';
  reason?: string;
  failed_constraints?: FailedConstraint[];
  metadata?: Record<string, unknown>;
  approval_id?: string;
  receipt?: ReceiptSummary;
  denial?: CloudDenialDetails;
  outputRules?: OutputRule[];
  /** Session state returned when sessionId is provided in context */
  session?: SessionState;
}

/**
 * Live session state returned in validation responses.
 */
export interface SessionState {
  /** Declared session budget */
  budget: number;
  /** Cumulative spend so far */
  spent: number;
  /** Budget minus spent */
  remaining: number;
  /** Named counter values */
  counters: Record<string, number>;
}

/**
 * Approval record returned from polling.
 */
export interface ApprovalData {
  id: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt?: string;
}

/**
 * Options for polling an approval.
 */
export interface ApprovalPollOptions {
  /** Milliseconds between poll requests. Default: 2000 */
  pollInterval?: number;
  /** Maximum milliseconds to wait before timing out. Default: 300000 (5 min) */
  timeout?: number;
}

/**
 * Policy data returned from the server for client-side validation.
 */
export interface CloudPolicyResponse {
  toolName: string;
  mode: 'deterministic' | 'llm';
  constraints: ArgumentConstraint[];
  sessionConstraints?: SessionConstraints;
  rateLimits?: unknown;
  version: number;
}

export interface CloudPoliciesResponse {
  policies: Rule[];
  outputRules?: OutputRule[];
}

/**
 * Request payload for logging a client-side decision to the server.
 */
export interface LogDecisionRequest {
  tool_name: string;
  arguments: Record<string, unknown>;
  decision: 'allow' | 'deny';
  reason?: string;
  mode: 'deterministic';
  latency_ms: number;
  source: 'client';
  context?: Record<string, unknown>;
  redactions?: RedactionTrace[];
  liftTrace?: OutputRuleLiftTrace[];
}
