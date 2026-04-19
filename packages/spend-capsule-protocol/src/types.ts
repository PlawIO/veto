export const CAPSULE_VERSION = "veto.capsule/1" as const;
export const RECEIPT_VERSION = "veto.receipt/1" as const;
export const JWS_TYP = "veto.capsule+jws" as const;

export const GENESIS_PREV_RECEIPT_HASH =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export type Rail =
  | "ach"
  | "wire"
  | "international_wire"
  | "book"
  | "usdc.eth"
  | "usdc.sol"
  | "usdc.base"
  | "usdc.arb";

export interface AmountCeiling {
  currency: string;
  amount: string;
}

export interface CapsulePayload {
  version: typeof CAPSULE_VERSION;
  capsule_id: string;
  issuer: string;
  entity_id: string;
  agent_id: string;
  session_id?: string;
  rail_allowlist: Rail[];
  counterparty_hash: string;
  amount_ceiling: AmountCeiling;
  memo_template?: string;
  invoice_hash: string;
  workflow_id: string;
  policy_sha256: string;
  approval_ref?: string | null;
  dual_control_ref?: string | null;
  issued_at: string;
  expires_at: string;
  max_uses?: number;
  nonce: string;
}

export type Decision = "allow" | "deny" | "require_approval";

export interface ReceiptAmount {
  currency: string;
  amount: string;
}

export interface ReceiptPayload {
  version: typeof RECEIPT_VERSION;
  receipt_id: string;
  entity_id: string;
  agent_id: string;
  session_id?: string;
  workflow_id?: string;
  capsule_id?: string | null;
  tool: string;
  decision: Decision;
  reason_code?: string;
  reason_detail?: string;
  args_hash: string;
  result_hash?: string | null;
  approval_hash?: string | null;
  policy_hash: string;
  policy_pack_id?: string;
  counterparty_hash?: string | null;
  rail?: string | null;
  amount?: ReceiptAmount | null;
  issued_at: string;
  prev_receipt_hash: string;
  merkle_root: string;
}

export interface BankUsBeneficiary {
  type: "bank_us";
  name: string;
  routing: string;
  account_last4: string;
}

export interface BankInternationalBeneficiary {
  type: "bank_intl";
  name: string;
  iban?: string;
  swift_bic?: string;
  country_iso?: string;
}

export interface CryptoBeneficiary {
  type: "crypto";
  chain: string;
  address: string;
}

export type Beneficiary =
  | BankUsBeneficiary
  | BankInternationalBeneficiary
  | CryptoBeneficiary;

export interface JwksKey {
  kty: "OKP";
  crv: "Ed25519";
  kid: string;
  x: string;
  alg?: "EdDSA";
  use?: "sig";
}

export interface Jwks {
  keys: JwksKey[];
}

export interface VerifyOptions {
  clockSkewSeconds?: number;
  now?: Date;
}

export interface VerifyCapsuleResult {
  payload: CapsulePayload;
  protectedHeader: {
    alg: "EdDSA";
    typ: typeof JWS_TYP;
    kid: string;
  };
}

export interface ChainVerifyResult {
  ok: boolean;
  breakAt?: number;
  reason?: string;
}
