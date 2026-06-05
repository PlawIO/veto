use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use veto_core::{canonicalize, compute_commitment, validate_fixture, MapDecision};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/map-core/fixtures")
}

#[test]
fn validates_map_core_fixtures() {
    let mut seen = Vec::new();
    for entry in fs::read_dir(fixtures_dir()).expect("fixture dir") {
        let entry = entry.expect("fixture entry");
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(entry.path()).expect("fixture json");
        let value: Value = serde_json::from_str(&raw).expect("valid json fixture");
        let result = validate_fixture(&value).expect("fixture verifies");
        seen.push((result.fixture_name, result.decision, result.reason_code));
    }
    seen.sort_by(|left, right| left.0.cmp(&right.0));

    assert_eq!(
        seen,
        vec![
            (
                "allow_refund".to_string(),
                MapDecision::Allow,
                "under_refund_limit".to_string()
            ),
            (
                "approval_replay_denied".to_string(),
                MapDecision::Deny,
                "approval_commitment_mismatch".to_string()
            ),
            (
                "deny_wire".to_string(),
                MapDecision::Deny,
                "missing_wire_authority".to_string()
            ),
            (
                "require_approval_refund".to_string(),
                MapDecision::RequireApproval,
                "refund_over_autonomous_limit".to_string()
            ),
        ]
    );
}

#[test]
fn computes_same_commitment_as_fixture_outcomes() {
    let raw = fs::read_to_string(fixtures_dir().join("allow-refund.json")).expect("fixture json");
    let value: Value = serde_json::from_str(&raw).expect("valid json fixture");
    let artifacts = value["artifacts"].as_array().expect("artifacts");
    let proposal = artifacts
        .iter()
        .find(|artifact| artifact["version"] == "map.action_proposal/0.1")
        .expect("proposal");
    let outcome = artifacts
        .iter()
        .find(|artifact| artifact["version"] == "map.decision_outcome/0.1")
        .expect("outcome");

    assert_eq!(
        compute_commitment(proposal).unwrap(),
        outcome["action_commitment"].as_str().unwrap()
    );
}

#[test]
fn canonicalizes_keys_in_bytewise_order() {
    let value = serde_json::json!({ "b": 1, "a": 2, "aa": 3 });
    assert_eq!(canonicalize(&value).unwrap(), r#"{"a":2,"aa":3,"b":1}"#);
}

#[test]
fn fails_closed_on_approval_replay_tampering() {
    let raw = fs::read_to_string(fixtures_dir().join("approval-replay-denied.json"))
        .expect("fixture json");
    let mut value: Value = serde_json::from_str(&raw).expect("valid json fixture");
    let artifacts = value["artifacts"].as_array_mut().expect("artifacts");
    let replay_commitment = artifacts
        .iter()
        .find(|artifact| artifact["version"] == "map.decision_outcome/0.1")
        .and_then(|artifact| artifact["action_commitment"].as_str())
        .expect("outcome commitment")
        .to_string();
    let approval = artifacts
        .iter_mut()
        .find(|artifact| artifact["version"] == "map.approval/0.1")
        .expect("approval");
    approval["proposal_id"] = Value::String("prop_refund_900_replay".to_string());
    approval["action_commitment"] = Value::String(replay_commitment);

    let err = validate_fixture(&value).expect_err("tampered replay should fail closed");
    assert!(err
        .to_string()
        .contains("expected an approval commitment mismatch"));
}
