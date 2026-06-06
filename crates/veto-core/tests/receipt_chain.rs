use serde_json::{json, Value};
use veto_core::{
    hash_receipt, parse_receipt_ndjson, verify_receipt, verify_receipt_chain,
    GENESIS_PREVIOUS_RECEIPT_HASH,
};

fn receipt(overrides: Value) -> Value {
    let mut base = json!({
        "version": "veto.receipt/1",
        "receipt_id": "rcp_aaaaaaaaaaaaaaaaaaaaaaaa",
        "organization_id": "org_test",
        "project_id": "proj_test",
        "decision_id": "dec_test",
        "approval_id": null,
        "session_id": null,
        "agent_id": "agent_test",
        "client_id": "client_test",
        "connection_id": null,
        "upstream_id": null,
        "tool_name": "issue_refund",
        "tool_schema_hash": null,
        "policy_id": "pol_test",
        "policy_version": "1",
        "policy_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "decision": "allow",
        "reason_code": "allowed",
        "reason_detail": "matched allow rule",
        "redacted_arguments": { "amount_usd": 100 },
        "argument_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        "result_hash": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        "approval_hash": null,
        "previous_receipt_hash": GENESIS_PREVIOUS_RECEIPT_HASH,
        "merkle_root": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        "timestamp": "2026-06-04T12:00:00Z",
        "trace_id": null
    });
    let base_obj = base.as_object_mut().expect("object");
    for (key, value) in overrides.as_object().expect("overrides") {
        base_obj.insert(key.clone(), value.clone());
    }
    base
}

#[test]
fn verifies_receipt_and_chain_links() {
    let first = receipt(json!({}));
    let second = receipt(json!({
        "receipt_id": "rcp_bbbbbbbbbbbbbbbbbbbbbbbb",
        "decision_id": "dec_second",
        "previous_receipt_hash": hash_receipt(&first).unwrap(),
        "timestamp": "2026-06-04T12:00:01Z"
    }));

    let summary = verify_receipt(&first).expect("valid receipt");
    assert_eq!(summary.previous_receipt_hash, GENESIS_PREVIOUS_RECEIPT_HASH);
    assert!(verify_receipt_chain(&[first, second]).ok);
}

#[test]
fn detects_receipt_tampering() {
    let first = receipt(json!({}));
    let second = receipt(json!({
        "receipt_id": "rcp_bbbbbbbbbbbbbbbbbbbbbbbb",
        "decision_id": "dec_second",
        "previous_receipt_hash": hash_receipt(&first).unwrap(),
        "timestamp": "2026-06-04T12:00:01Z"
    }));
    let mut tampered_first = first.clone();
    tampered_first["reason_detail"] = Value::String("tampered".to_string());

    let result = verify_receipt_chain(&[tampered_first, second]);
    assert!(!result.ok);
    assert_eq!(result.break_at, Some(1));
}

#[test]
fn parses_ndjson_exports() {
    let first = receipt(json!({}));
    let second = receipt(json!({
        "receipt_id": "rcp_bbbbbbbbbbbbbbbbbbbbbbbb",
        "decision_id": "dec_second",
        "previous_receipt_hash": hash_receipt(&first).unwrap(),
        "timestamp": "2026-06-04T12:00:01Z"
    }));
    let ndjson = format!(
        "{}\n{}\n",
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap()
    );
    let receipts = parse_receipt_ndjson(&ndjson).expect("valid ndjson");
    assert_eq!(receipts.len(), 2);
    assert!(verify_receipt_chain(&receipts).ok);
}
