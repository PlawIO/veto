export const MAP_ACTION_PROPOSAL_VERSION = "map.action_proposal/0.1" as const;
export const MAP_AUTHORITY_VERSION = "map.authority/0.1" as const;
export const MAP_POLICY_BUNDLE_VERSION = "map.policy_pack/0.1" as const;
export const MAP_APPROVAL_VERSION = "map.approval/0.1" as const;
export const MAP_DECISION_OUTCOME_VERSION = "map.decision_outcome/0.1" as const;
export const MAP_RECEIPT_VERSION = "map.receipt/0.1" as const;

export type MapDecision = "allow" | "deny" | "require_approval";

export interface MapActor {
  id: string;
  kind: "human" | "agent" | "service" | "organization";
}

export interface MapActionProposal {
  version: typeof MAP_ACTION_PROPOSAL_VERSION;
  proposal_id: string;
  action: string;
  arguments: unknown;
  actor: MapActor;
  subject?: MapActor | null;
  audience: string[];
  created_at: string;
  expires_at?: string | null;
  nonce: string;
}

export interface MapAuthority {
  version: typeof MAP_AUTHORITY_VERSION;
  authority_id: string;
  issuer: MapActor;
  subject: MapActor;
  delegator?: MapActor | null;
  audience: string[];
  actions: string[];
  scope: Record<string, unknown>;
  limits?: Record<string, unknown> | null;
  conditions?: Record<string, unknown> | null;
  valid_from: string;
  valid_until?: string | null;
  evidence?: Record<string, unknown> | null;
  receipt_required: boolean;
}

export interface MapPolicyRule {
  rule_id: string;
  action: string;
  effect: MapDecision;
  reason_code: string;
  conditions?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
}

export interface MapPolicyBundle {
  version: typeof MAP_POLICY_BUNDLE_VERSION;
  bundle_id: string;
  issuer: MapActor;
  audience: string[];
  valid_from: string;
  valid_until?: string | null;
  authorities: MapAuthority[];
  rules: MapPolicyRule[];
  default_decision: MapDecision;
  receipt_required: boolean;
}

export interface MapApproval {
  version: typeof MAP_APPROVAL_VERSION;
  approval_id: string;
  proposal_id: string;
  action_commitment: string;
  approver: MapActor;
  decision: "approved" | "denied";
  reason_code?: string | null;
  created_at: string;
  expires_at: string;
  nonce: string;
}

export interface MapDecisionOutcome {
  version: typeof MAP_DECISION_OUTCOME_VERSION;
  outcome_id: string;
  proposal_id: string;
  action_commitment: string;
  policy_bundle_id?: string | null;
  decision: MapDecision;
  reason_code: string;
  reason_detail?: string | null;
  approval_id?: string | null;
  receipt_required: boolean;
  evaluated_at: string;
}

export interface MapReceiptPointer {
  version: typeof MAP_RECEIPT_VERSION;
  receipt_id: string;
  receipt_hash: string;
  outcome_id: string;
  decision_id?: string | null;
}

export type MapArtifact =
  | MapActionProposal
  | MapAuthority
  | MapPolicyBundle
  | MapApproval
  | MapDecisionOutcome
  | MapReceiptPointer;

export interface MapFixture {
  name: string;
  description: string;
  artifacts: MapArtifact[];
  expected_decision: MapDecision;
  expected_reason_code: string;
}
