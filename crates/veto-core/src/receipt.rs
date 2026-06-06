use serde_json::Value;

use crate::canonical::compute_commitment;
use crate::error::{VetoCoreError, VetoCoreResult};
use crate::rfc3339::parse_rfc3339_epoch_millis;

pub const RECEIPT_VERSION: &str = "veto.receipt/1";
pub const GENESIS_PREVIOUS_RECEIPT_HASH: &str =
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const MERKLE_BLOCK_SIZE: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptSummary {
    pub receipt_id: String,
    pub receipt_hash: String,
    pub previous_receipt_hash: String,
    pub merkle_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainVerifyResult {
    pub ok: bool,
    pub break_at: Option<usize>,
    pub reason: Option<String>,
}

pub fn hash_receipt(receipt: &Value) -> VetoCoreResult<String> {
    validate_receipt_value(receipt)?;
    compute_commitment(receipt)
}

pub fn verify_receipt(receipt: &Value) -> VetoCoreResult<ReceiptSummary> {
    let obj = validate_receipt_value(receipt)?;
    Ok(ReceiptSummary {
        receipt_id: string_field(obj, "receipt_id", "$.receipt_id")?.to_string(),
        receipt_hash: compute_commitment(receipt)?,
        previous_receipt_hash: string_field(
            obj,
            "previous_receipt_hash",
            "$.previous_receipt_hash",
        )?
        .to_string(),
        merkle_root: string_field(obj, "merkle_root", "$.merkle_root")?.to_string(),
    })
}

pub fn verify_receipt_chain(receipts: &[Value]) -> ChainVerifyResult {
    if receipts.is_empty() {
        return ChainVerifyResult {
            ok: true,
            break_at: None,
            reason: None,
        };
    }

    let mut previous_issued_ms = i64::MIN;
    let mut previous_merkle_root: Option<String> = None;
    for (index, receipt) in receipts.iter().enumerate() {
        let obj = match validate_receipt_value(receipt) {
            Ok(obj) => obj,
            Err(err) => return chain_error(index, format!("receipt[{index}] invalid: {err}")),
        };

        let expected_previous = if index == 0 {
            GENESIS_PREVIOUS_RECEIPT_HASH.to_string()
        } else {
            match compute_commitment(&receipts[index - 1]) {
                Ok(hash) => hash,
                Err(err) => {
                    return chain_error(
                        index,
                        format!("could not hash receipt[{}]: {err}", index - 1),
                    )
                }
            }
        };
        let previous_hash =
            match string_field(obj, "previous_receipt_hash", "$.previous_receipt_hash") {
                Ok(value) => value,
                Err(err) => return chain_error(index, format!("receipt[{index}] invalid: {err}")),
            };
        if previous_hash != expected_previous {
            return chain_error(
                index,
                if index == 0 {
                    "receipt[0] previous_receipt_hash must be the genesis hash".to_string()
                } else {
                    format!("receipt[{index}] previous_receipt_hash does not match sha256 of receipt[{}]", index - 1)
                },
            );
        }

        let timestamp = match string_field(obj, "timestamp", "$.timestamp") {
            Ok(value) => value,
            Err(err) => return chain_error(index, format!("receipt[{index}] invalid: {err}")),
        };
        let issued_ms = match parse_rfc3339_epoch_millis(timestamp) {
            Ok(value) => value,
            Err(err) => {
                return chain_error(index, format!("receipt[{index}] invalid timestamp: {err}"))
            }
        };
        if issued_ms + 5_000 < previous_issued_ms {
            return chain_error(
                index,
                format!("receipt[{index}] timestamp {timestamp} precedes receipt[{}].timestamp beyond tolerated skew", index - 1),
            );
        }
        previous_issued_ms = previous_issued_ms.max(issued_ms);

        let merkle_root = match string_field(obj, "merkle_root", "$.merkle_root") {
            Ok(value) => value.to_string(),
            Err(err) => return chain_error(index, format!("receipt[{index}] invalid: {err}")),
        };
        if let Some(previous) = &previous_merkle_root {
            if &merkle_root != previous && index % MERKLE_BLOCK_SIZE != 0 {
                return chain_error(
                    index,
                    format!(
                        "receipt[{index}] merkle_root changed mid-block (position {})",
                        index % MERKLE_BLOCK_SIZE
                    ),
                );
            }
        }
        previous_merkle_root = Some(merkle_root);
    }

    ChainVerifyResult {
        ok: true,
        break_at: None,
        reason: None,
    }
}

pub fn parse_receipt_ndjson(input: &str) -> VetoCoreResult<Vec<Value>> {
    let mut receipts = Vec::new();
    for (index, line) in input.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let receipt: Value = serde_json::from_str(trimmed).map_err(|err| {
            VetoCoreError::Json(format!("line {}: invalid JSON: {err}", index + 1))
        })?;
        validate_receipt_value(&receipt)?;
        receipts.push(receipt);
    }
    Ok(receipts)
}

fn validate_receipt_value(receipt: &Value) -> VetoCoreResult<&serde_json::Map<String, Value>> {
    let obj = receipt
        .as_object()
        .ok_or_else(|| VetoCoreError::InvalidReceipt {
            path: "$".to_string(),
            message: "must be a JSON object".to_string(),
        })?;

    const REQUIRED: &[&str] = &[
        "version",
        "receipt_id",
        "organization_id",
        "project_id",
        "decision_id",
        "tool_name",
        "policy_version",
        "policy_hash",
        "decision",
        "redacted_arguments",
        "argument_hash",
        "result_hash",
        "approval_hash",
        "previous_receipt_hash",
        "merkle_root",
        "timestamp",
    ];
    const ALLOWED: &[&str] = &[
        "version",
        "receipt_id",
        "organization_id",
        "project_id",
        "decision_id",
        "approval_id",
        "session_id",
        "agent_id",
        "client_id",
        "connection_id",
        "upstream_id",
        "tool_name",
        "tool_schema_hash",
        "policy_id",
        "policy_version",
        "policy_hash",
        "decision",
        "reason_code",
        "reason_detail",
        "redacted_arguments",
        "argument_hash",
        "result_hash",
        "approval_hash",
        "previous_receipt_hash",
        "merkle_root",
        "timestamp",
        "trace_id",
    ];

    for key in obj.keys() {
        if !ALLOWED.contains(&key.as_str()) {
            return invalid_receipt(&format!("$.{key}"), "additional properties are not allowed");
        }
    }
    for key in REQUIRED {
        if !obj.contains_key(*key) {
            return invalid_receipt(&format!("$.{key}"), "required field is missing");
        }
    }

    if string_field(obj, "version", "$.version")? != RECEIPT_VERSION {
        return invalid_receipt("$.version", "must be the literal veto.receipt/1");
    }
    validate_receipt_id(
        string_field(obj, "receipt_id", "$.receipt_id")?,
        "$.receipt_id",
    )?;
    validate_id(
        string_field(obj, "organization_id", "$.organization_id")?,
        "$.organization_id",
    )?;
    validate_string_or_null(obj, "project_id", "$.project_id", Some(validate_id))?;
    validate_id(
        string_field(obj, "decision_id", "$.decision_id")?,
        "$.decision_id",
    )?;
    validate_string_or_null(obj, "approval_id", "$.approval_id", Some(validate_id))?;
    validate_string_or_null(obj, "session_id", "$.session_id", Some(validate_id))?;
    validate_string_or_null(obj, "agent_id", "$.agent_id", Some(validate_id))?;
    validate_string_or_null(obj, "client_id", "$.client_id", Some(validate_id))?;
    validate_string_or_null(obj, "connection_id", "$.connection_id", None)?;
    validate_string_or_null(obj, "upstream_id", "$.upstream_id", Some(validate_id))?;
    validate_action(
        string_field(obj, "tool_name", "$.tool_name")?,
        "$.tool_name",
    )?;
    validate_string_or_null(
        obj,
        "tool_schema_hash",
        "$.tool_schema_hash",
        Some(validate_sha256),
    )?;
    validate_string_or_null(obj, "policy_id", "$.policy_id", Some(validate_id))?;
    if string_field(obj, "policy_version", "$.policy_version")?.is_empty() {
        return invalid_receipt("$.policy_version", "must not be empty");
    }
    validate_sha256(
        string_field(obj, "policy_hash", "$.policy_hash")?,
        "$.policy_hash",
    )?;

    match string_field(obj, "decision", "$.decision")? {
        "allow" | "deny" | "require_approval" | "approval_approved" | "approval_denied" => {}
        other => return invalid_receipt("$.decision", &format!("invalid decision: {other}")),
    }
    validate_string_or_null(obj, "reason_code", "$.reason_code", Some(validate_reason))?;
    validate_string_or_null(obj, "reason_detail", "$.reason_detail", None)?;
    validate_sha256(
        string_field(obj, "argument_hash", "$.argument_hash")?,
        "$.argument_hash",
    )?;
    validate_string_or_null(obj, "result_hash", "$.result_hash", Some(validate_sha256))?;
    validate_string_or_null(
        obj,
        "approval_hash",
        "$.approval_hash",
        Some(validate_sha256),
    )?;
    validate_sha256(
        string_field(obj, "previous_receipt_hash", "$.previous_receipt_hash")?,
        "$.previous_receipt_hash",
    )?;
    validate_sha256(
        string_field(obj, "merkle_root", "$.merkle_root")?,
        "$.merkle_root",
    )?;
    parse_rfc3339_epoch_millis(string_field(obj, "timestamp", "$.timestamp")?).map_err(|err| {
        VetoCoreError::InvalidReceipt {
            path: "$.timestamp".to_string(),
            message: err.to_string(),
        }
    })?;
    validate_string_or_null(obj, "trace_id", "$.trace_id", None)?;
    Ok(obj)
}

fn string_field<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
    path: &str,
) -> VetoCoreResult<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| VetoCoreError::InvalidReceipt {
            path: path.to_string(),
            message: "must be a string".to_string(),
        })
}

fn validate_string_or_null(
    obj: &serde_json::Map<String, Value>,
    key: &str,
    path: &str,
    validator: Option<fn(&str, &str) -> VetoCoreResult<()>>,
) -> VetoCoreResult<()> {
    let Some(value) = obj.get(key) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let text = value
        .as_str()
        .ok_or_else(|| VetoCoreError::InvalidReceipt {
            path: path.to_string(),
            message: "must be a string or null".to_string(),
        })?;
    if text.is_empty() {
        return invalid_receipt(path, "must not be empty");
    }
    if let Some(validate) = validator {
        validate(text, path)?;
    }
    Ok(())
}

fn validate_receipt_id(value: &str, path: &str) -> VetoCoreResult<()> {
    if value.len() == 28
        && value.starts_with("rcp_")
        && value[4..]
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
    {
        Ok(())
    } else {
        invalid_receipt(path, "must match rcp_[0-9a-z]{24}")
    }
}

fn validate_id(value: &str, path: &str) -> VetoCoreResult<()> {
    validate_ascii(value, path, 1, 200, |ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-')
    })
}

fn validate_action(value: &str, path: &str) -> VetoCoreResult<()> {
    validate_ascii(value, path, 1, 200, |ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-')
    })
}

fn validate_reason(value: &str, path: &str) -> VetoCoreResult<()> {
    if !value
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic())
    {
        return invalid_receipt(path, "must start with a letter");
    }
    validate_ascii(value, path, 1, 128, |ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-')
    })
}

fn validate_sha256(value: &str, path: &str) -> VetoCoreResult<()> {
    if value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        Ok(())
    } else {
        invalid_receipt(path, "must be sha256:<64 lowercase hex chars>")
    }
}

fn validate_ascii<F>(
    value: &str,
    path: &str,
    min: usize,
    max: usize,
    allow: F,
) -> VetoCoreResult<()>
where
    F: Fn(char) -> bool,
{
    if value.len() < min {
        return invalid_receipt(path, "must not be empty");
    }
    if value.len() > max {
        return invalid_receipt(path, "exceeds maximum length");
    }
    if value.chars().all(allow) {
        Ok(())
    } else {
        invalid_receipt(path, "contains unsupported characters")
    }
}

fn invalid_receipt<T>(path: &str, message: &str) -> VetoCoreResult<T> {
    Err(VetoCoreError::InvalidReceipt {
        path: path.to_string(),
        message: message.to_string(),
    })
}

fn chain_error(index: usize, reason: String) -> ChainVerifyResult {
    ChainVerifyResult {
        ok: false,
        break_at: Some(index),
        reason: Some(reason),
    }
}
