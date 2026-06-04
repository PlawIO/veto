export const RECEIPT_VERSION = "veto.receipt/1" as const;

export const GENESIS_PREVIOUS_RECEIPT_HASH =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export type ReceiptDecision =
  | "allow"
  | "deny"
  | "require_approval"
  | "approval_approved"
  | "approval_denied";

export interface DecisionReceiptPayload {
  version: typeof RECEIPT_VERSION;
  receipt_id: string;
  organization_id: string;
  project_id: string | null;
  decision_id: string;
  approval_id?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  client_id?: string | null;
  connection_id?: string | null;
  upstream_id?: string | null;
  tool_name: string;
  tool_schema_hash?: string | null;
  policy_id?: string | null;
  policy_version: string;
  policy_hash: string;
  decision: ReceiptDecision;
  reason_code?: string | null;
  reason_detail?: string | null;
  redacted_arguments: unknown;
  argument_hash: string;
  result_hash: string | null;
  approval_hash: string | null;
  previous_receipt_hash: string;
  merkle_root: string;
  timestamp: string;
  trace_id?: string | null;
}

export type DecisionReceiptDraft = Omit<
  DecisionReceiptPayload,
  "version" | "previous_receipt_hash" | "merkle_root"
>;

export interface ReceiptSummary {
  receipt_id: string;
  receipt_hash: string;
  previous_receipt_hash: string;
  merkle_root: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  breakAt?: number;
  reason?: string;
}
