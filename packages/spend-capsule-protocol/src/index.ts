export {
  CAPSULE_VERSION,
  RECEIPT_VERSION,
  JWS_TYP,
  GENESIS_PREV_RECEIPT_HASH,
} from "./types.js";

export type {
  AmountCeiling,
  BankInternationalBeneficiary,
  BankUsBeneficiary,
  Beneficiary,
  CapsulePayload,
  ChainVerifyResult,
  CryptoBeneficiary,
  Decision,
  Jwks,
  JwksKey,
  Rail,
  ReceiptAmount,
  ReceiptPayload,
  VerifyCapsuleResult,
  VerifyOptions,
} from "./types.js";

export {
  canonicalize,
  hashBeneficiary,
  hashCanonical,
  normalizeBeneficiary,
  sha256Hex,
  sha256Prefixed,
} from "./hash.js";

export {
  CapsuleVerificationError,
  publicJwkFromPrivate,
  signCapsule,
  verifyCapsule,
} from "./sign.js";
export type { PrivateSigningKey } from "./sign.js";

export {
  anchorBlock,
  buildReceipt,
  combineAnchors,
  computeMerkleRoot,
  GENESIS_MERKLE_ROOT,
  hashReceipt,
  MERKLE_BLOCK_SIZE,
  verifyReceiptChain,
} from "./merkle.js";
export type { BuildReceiptInput, MerkleAnchor, ReceiptDraft } from "./merkle.js";
