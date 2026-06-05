use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical::compute_commitment_serializable;
use crate::error::{VetoCoreError, VetoCoreResult};
use crate::rfc3339::parse_rfc3339_epoch_seconds;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapDecision {
    Allow,
    Deny,
    RequireApproval,
}

impl MapDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::RequireApproval => "require_approval",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapActorKind {
    Human,
    Agent,
    Service,
    Organization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapActor {
    pub id: String,
    pub kind: MapActorKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapActionProposal {
    pub proposal_id: String,
    pub action: String,
    #[serde(default)]
    pub arguments: Value,
    pub actor: MapActor,
    #[serde(default)]
    pub subject: Option<MapActor>,
    pub audience: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapAuthority {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub authority_id: String,
    pub issuer: MapActor,
    pub subject: MapActor,
    #[serde(default)]
    pub delegator: Option<MapActor>,
    pub audience: Vec<String>,
    pub actions: Vec<String>,
    pub scope: Value,
    #[serde(default)]
    pub limits: Option<Value>,
    #[serde(default)]
    pub conditions: Option<Value>,
    pub valid_from: String,
    #[serde(default)]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub evidence: Option<Value>,
    pub receipt_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapPolicyRule {
    pub rule_id: String,
    pub action: String,
    pub effect: MapDecision,
    pub reason_code: String,
    #[serde(default)]
    pub conditions: Option<Value>,
    #[serde(default)]
    pub limits: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapPolicyBundle {
    pub bundle_id: String,
    pub issuer: MapActor,
    pub audience: Vec<String>,
    pub valid_from: String,
    #[serde(default)]
    pub valid_until: Option<String>,
    pub authorities: Vec<MapAuthority>,
    pub rules: Vec<MapPolicyRule>,
    pub default_decision: MapDecision,
    pub receipt_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapApproval {
    pub approval_id: String,
    pub proposal_id: String,
    pub action_commitment: String,
    pub approver: MapActor,
    pub decision: ApprovalDecision,
    #[serde(default)]
    pub reason_code: Option<String>,
    pub created_at: String,
    pub expires_at: String,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapDecisionOutcome {
    pub outcome_id: String,
    pub proposal_id: String,
    pub action_commitment: String,
    #[serde(default)]
    pub policy_bundle_id: Option<String>,
    pub decision: MapDecision,
    pub reason_code: String,
    #[serde(default)]
    pub reason_detail: Option<String>,
    #[serde(default)]
    pub approval_id: Option<String>,
    pub receipt_required: bool,
    pub evaluated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapReceiptPointer {
    pub receipt_id: String,
    pub receipt_hash: String,
    pub outcome_id: String,
    #[serde(default)]
    pub decision_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "version")]
pub enum MapArtifact {
    #[serde(rename = "map.action_proposal/0.1")]
    ActionProposal(MapActionProposal),
    #[serde(rename = "map.authority/0.1")]
    Authority(MapAuthority),
    #[serde(rename = "map.policy_pack/0.1")]
    PolicyBundle(MapPolicyBundle),
    #[serde(rename = "map.approval/0.1")]
    Approval(MapApproval),
    #[serde(rename = "map.decision_outcome/0.1")]
    DecisionOutcome(MapDecisionOutcome),
    #[serde(rename = "map.receipt/0.1")]
    ReceiptPointer(MapReceiptPointer),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MapFixture {
    pub name: String,
    pub description: String,
    pub artifacts: Vec<MapArtifact>,
    pub expected_decision: MapDecision,
    pub expected_reason_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureVerification {
    pub fixture_name: String,
    pub decision: MapDecision,
    pub reason_code: String,
}

#[derive(Debug, Clone)]
pub struct EnforcementRequest {
    pub proposal: MapActionProposal,
    pub bundle: Option<MapPolicyBundle>,
    pub approval: Option<MapApproval>,
    pub evaluated_at: String,
    pub outcome_id: String,
}

pub fn verify_bundle(bundle: &MapPolicyBundle, evaluated_at: &str) -> VetoCoreResult<()> {
    validate_policy_bundle(bundle)?;
    let now = parse_rfc3339_epoch_seconds(evaluated_at)?;
    let valid_from = parse_rfc3339_epoch_seconds(&bundle.valid_from)?;
    if now < valid_from {
        return Err(VetoCoreError::Verification(format!(
            "policy bundle {} is not valid yet",
            bundle.bundle_id
        )));
    }
    if let Some(valid_until) = &bundle.valid_until {
        if now > parse_rfc3339_epoch_seconds(valid_until)? {
            return Err(VetoCoreError::Verification(format!(
                "policy bundle {} has expired",
                bundle.bundle_id
            )));
        }
    }
    Ok(())
}

pub fn enforce(request: EnforcementRequest) -> VetoCoreResult<MapDecisionOutcome> {
    validate_action_proposal(&request.proposal)?;
    if let Some(bundle) = &request.bundle {
        validate_policy_bundle(bundle)?;
    }
    if let Some(approval) = &request.approval {
        validate_approval(approval)?;
    }

    let evaluated_at_seconds = parse_rfc3339_epoch_seconds(&request.evaluated_at)?;
    let commitment = action_commitment(&request.proposal)?;

    if let Some(expires_at) = &request.proposal.expires_at {
        if evaluated_at_seconds > parse_rfc3339_epoch_seconds(expires_at)? {
            return Ok(deny_outcome(
                &request,
                commitment,
                "proposal_expired",
                request
                    .approval
                    .as_ref()
                    .map(|approval| approval.approval_id.clone()),
            ));
        }
    }

    if let Some(approval) = &request.approval {
        if approval.proposal_id != request.proposal.proposal_id
            || approval.action_commitment != commitment
        {
            return Ok(deny_outcome(
                &request,
                commitment,
                "approval_commitment_mismatch",
                Some(approval.approval_id.clone()),
            ));
        }
        if evaluated_at_seconds > parse_rfc3339_epoch_seconds(&approval.expires_at)? {
            return Ok(deny_outcome(
                &request,
                commitment,
                "approval_expired",
                Some(approval.approval_id.clone()),
            ));
        }
        if approval.decision == ApprovalDecision::Denied {
            return Ok(deny_outcome(
                &request,
                commitment,
                approval.reason_code.as_deref().unwrap_or("approval_denied"),
                Some(approval.approval_id.clone()),
            ));
        }
    }

    let Some(bundle) = &request.bundle else {
        return Ok(deny_outcome(
            &request,
            commitment,
            "missing_policy_bundle",
            None,
        ));
    };
    if let Err(err) = verify_bundle(bundle, &request.evaluated_at) {
        return Ok(deny_outcome(
            &request,
            commitment,
            &err.to_string_reason(),
            None,
        ));
    }
    if !audience_intersects(&request.proposal.audience, &bundle.audience) {
        return Ok(deny_outcome(
            &request,
            commitment,
            "audience_mismatch",
            None,
        ));
    }

    let authority_present = has_matching_authority(bundle, &request.proposal, evaluated_at_seconds);
    for rule in &bundle.rules {
        if rule.action != request.proposal.action
            || !conditions_match(
                &rule.conditions,
                &request.proposal,
                authority_present,
                &rule.effect,
            )
        {
            continue;
        }
        if rule.effect == MapDecision::Allow && !authority_present {
            return Ok(deny_outcome(
                &request,
                commitment,
                "missing_authority",
                None,
            ));
        }
        return Ok(MapDecisionOutcome {
            outcome_id: request.outcome_id,
            proposal_id: request.proposal.proposal_id,
            action_commitment: commitment,
            policy_bundle_id: Some(bundle.bundle_id.clone()),
            decision: rule.effect.clone(),
            reason_code: rule.reason_code.clone(),
            reason_detail: None,
            approval_id: if rule.effect == MapDecision::RequireApproval {
                request.approval.map(|approval| approval.approval_id)
            } else {
                None
            },
            receipt_required: bundle.receipt_required,
            evaluated_at: request.evaluated_at,
        });
    }

    Ok(MapDecisionOutcome {
        outcome_id: request.outcome_id,
        proposal_id: request.proposal.proposal_id,
        action_commitment: commitment,
        policy_bundle_id: Some(bundle.bundle_id.clone()),
        decision: bundle.default_decision.clone(),
        reason_code: "default_decision".to_string(),
        reason_detail: None,
        approval_id: None,
        receipt_required: bundle.receipt_required,
        evaluated_at: request.evaluated_at,
    })
}

pub fn validate_fixture(value: &Value) -> VetoCoreResult<FixtureVerification> {
    let fixture: MapFixture = serde_json::from_value(value.clone())?;
    validate_id(&fixture.name, "$.name")?;
    let mut proposals = HashMap::<String, MapActionProposal>::new();
    let mut bundles = Vec::<MapPolicyBundle>::new();
    let mut approvals = HashMap::<String, MapApproval>::new();
    let mut outcomes = Vec::<MapDecisionOutcome>::new();

    for artifact in &fixture.artifacts {
        validate_artifact(artifact)?;
        match artifact {
            MapArtifact::ActionProposal(proposal) => {
                proposals.insert(proposal.proposal_id.clone(), proposal.clone());
            }
            MapArtifact::PolicyBundle(bundle) => bundles.push(bundle.clone()),
            MapArtifact::Approval(approval) => {
                approvals.insert(approval.approval_id.clone(), approval.clone());
            }
            MapArtifact::DecisionOutcome(outcome) => outcomes.push(outcome.clone()),
            MapArtifact::Authority(_) | MapArtifact::ReceiptPointer(_) => {}
        }
    }

    if outcomes.is_empty() {
        return Err(VetoCoreError::Verification(format!(
            "fixture {} has no decision outcome",
            fixture.name
        )));
    }

    for outcome in &outcomes {
        let proposal = proposals.get(&outcome.proposal_id).ok_or_else(|| {
            VetoCoreError::Verification(format!("missing proposal {}", outcome.proposal_id))
        })?;
        let commitment = action_commitment(proposal)?;
        if outcome.action_commitment != commitment {
            return Err(VetoCoreError::Verification(format!(
                "outcome {} action commitment mismatch",
                outcome.outcome_id
            )));
        }

        if let Some(approval_id) = &outcome.approval_id {
            if let Some(approval) = approvals.get(approval_id) {
                if outcome.reason_code == "approval_commitment_mismatch"
                    && approval.action_commitment == outcome.action_commitment
                {
                    return Err(VetoCoreError::Verification(
                        "replay fixture expected an approval commitment mismatch".to_string(),
                    ));
                }
            }
        }

        if let Some(bundle) = bundles
            .iter()
            .find(|bundle| Some(bundle.bundle_id.as_str()) == outcome.policy_bundle_id.as_deref())
        {
            let approval = outcome
                .approval_id
                .as_ref()
                .and_then(|id| approvals.get(id))
                .cloned();
            let enforced = enforce(EnforcementRequest {
                proposal: proposal.clone(),
                bundle: Some(bundle.clone()),
                approval,
                evaluated_at: outcome.evaluated_at.clone(),
                outcome_id: outcome.outcome_id.clone(),
            })?;
            if enforced.decision != outcome.decision || enforced.reason_code != outcome.reason_code
            {
                return Err(VetoCoreError::Verification(format!(
                    "fixture {} outcome {} differs from kernel decision: expected {}/{}, got {}/{}",
                    fixture.name,
                    outcome.outcome_id,
                    outcome.decision.as_str(),
                    outcome.reason_code,
                    enforced.decision.as_str(),
                    enforced.reason_code,
                )));
            }
        } else if let Some(approval_id) = &outcome.approval_id {
            let approval = approvals.get(approval_id).cloned();
            let enforced = enforce(EnforcementRequest {
                proposal: proposal.clone(),
                bundle: None,
                approval,
                evaluated_at: outcome.evaluated_at.clone(),
                outcome_id: outcome.outcome_id.clone(),
            })?;
            if enforced.decision != outcome.decision || enforced.reason_code != outcome.reason_code
            {
                return Err(VetoCoreError::Verification(format!(
                    "fixture {} replay outcome differs from kernel decision",
                    fixture.name
                )));
            }
        }
    }

    let last = outcomes.last().expect("checked non-empty");
    if last.decision != fixture.expected_decision
        || last.reason_code != fixture.expected_reason_code
    {
        return Err(VetoCoreError::Verification(format!(
            "fixture {} expected {}/{}, got {}/{}",
            fixture.name,
            fixture.expected_decision.as_str(),
            fixture.expected_reason_code,
            last.decision.as_str(),
            last.reason_code,
        )));
    }

    Ok(FixtureVerification {
        fixture_name: fixture.name,
        decision: last.decision.clone(),
        reason_code: last.reason_code.clone(),
    })
}

fn validate_artifact(artifact: &MapArtifact) -> VetoCoreResult<()> {
    match artifact {
        MapArtifact::ActionProposal(value) => validate_action_proposal(value),
        MapArtifact::Authority(value) => validate_authority(value, "$"),
        MapArtifact::PolicyBundle(value) => validate_policy_bundle(value),
        MapArtifact::Approval(value) => validate_approval(value),
        MapArtifact::DecisionOutcome(value) => validate_decision_outcome(value),
        MapArtifact::ReceiptPointer(value) => validate_receipt_pointer(value),
    }
}

fn validate_action_proposal(value: &MapActionProposal) -> VetoCoreResult<()> {
    validate_id(&value.proposal_id, "$.proposal_id")?;
    validate_action(&value.action, "$.action")?;
    validate_actor(&value.actor, "$.actor")?;
    if let Some(subject) = &value.subject {
        validate_actor(subject, "$.subject")?;
    }
    validate_id_list(&value.audience, "$.audience")?;
    parse_rfc3339_epoch_seconds(&value.created_at)?;
    if let Some(expires_at) = &value.expires_at {
        parse_rfc3339_epoch_seconds(expires_at)?;
    }
    validate_id(&value.nonce, "$.nonce")
}

fn validate_authority(value: &MapAuthority, path: &str) -> VetoCoreResult<()> {
    if let Some(version) = &value.version {
        if version != "map.authority/0.1" {
            return invalid_artifact(&format!("{path}.version"), "unsupported authority version");
        }
    }
    validate_id(&value.authority_id, &format!("{path}.authority_id"))?;
    validate_actor(&value.issuer, &format!("{path}.issuer"))?;
    validate_actor(&value.subject, &format!("{path}.subject"))?;
    if let Some(delegator) = &value.delegator {
        validate_actor(delegator, &format!("{path}.delegator"))?;
    }
    validate_id_list(&value.audience, &format!("{path}.audience"))?;
    for (index, action) in value.actions.iter().enumerate() {
        validate_action(action, &format!("{path}.actions[{index}]"))?;
    }
    parse_rfc3339_epoch_seconds(&value.valid_from)?;
    if let Some(valid_until) = &value.valid_until {
        parse_rfc3339_epoch_seconds(valid_until)?;
    }
    Ok(())
}

fn validate_policy_bundle(value: &MapPolicyBundle) -> VetoCoreResult<()> {
    validate_id(&value.bundle_id, "$.bundle_id")?;
    validate_actor(&value.issuer, "$.issuer")?;
    validate_id_list(&value.audience, "$.audience")?;
    parse_rfc3339_epoch_seconds(&value.valid_from)?;
    if let Some(valid_until) = &value.valid_until {
        parse_rfc3339_epoch_seconds(valid_until)?;
    }
    for (index, authority) in value.authorities.iter().enumerate() {
        validate_authority(authority, &format!("$.authorities[{index}]"))?;
    }
    for (index, rule) in value.rules.iter().enumerate() {
        validate_action(&rule.action, &format!("$.rules[{index}].action"))?;
        validate_reason(&rule.reason_code, &format!("$.rules[{index}].reason_code"))?;
        validate_id(&rule.rule_id, &format!("$.rules[{index}].rule_id"))?;
    }
    Ok(())
}

fn validate_approval(value: &MapApproval) -> VetoCoreResult<()> {
    validate_id(&value.approval_id, "$.approval_id")?;
    validate_id(&value.proposal_id, "$.proposal_id")?;
    validate_sha256(&value.action_commitment, "$.action_commitment")?;
    validate_actor(&value.approver, "$.approver")?;
    if let Some(reason_code) = &value.reason_code {
        validate_reason(reason_code, "$.reason_code")?;
    }
    parse_rfc3339_epoch_seconds(&value.created_at)?;
    parse_rfc3339_epoch_seconds(&value.expires_at)?;
    validate_id(&value.nonce, "$.nonce")
}

fn validate_decision_outcome(value: &MapDecisionOutcome) -> VetoCoreResult<()> {
    validate_id(&value.outcome_id, "$.outcome_id")?;
    validate_id(&value.proposal_id, "$.proposal_id")?;
    validate_sha256(&value.action_commitment, "$.action_commitment")?;
    if let Some(policy_bundle_id) = &value.policy_bundle_id {
        validate_id(policy_bundle_id, "$.policy_bundle_id")?;
    }
    validate_reason(&value.reason_code, "$.reason_code")?;
    if let Some(approval_id) = &value.approval_id {
        validate_id(approval_id, "$.approval_id")?;
    }
    parse_rfc3339_epoch_seconds(&value.evaluated_at)?;
    Ok(())
}

fn validate_receipt_pointer(value: &MapReceiptPointer) -> VetoCoreResult<()> {
    validate_id(&value.receipt_id, "$.receipt_id")?;
    validate_sha256(&value.receipt_hash, "$.receipt_hash")?;
    validate_id(&value.outcome_id, "$.outcome_id")?;
    if let Some(decision_id) = &value.decision_id {
        validate_id(decision_id, "$.decision_id")?;
    }
    Ok(())
}

fn action_commitment(proposal: &MapActionProposal) -> VetoCoreResult<String> {
    compute_commitment_serializable(&MapArtifact::ActionProposal(proposal.clone()))
}

fn deny_outcome(
    request: &EnforcementRequest,
    action_commitment: String,
    reason_code: &str,
    approval_id: Option<String>,
) -> MapDecisionOutcome {
    MapDecisionOutcome {
        outcome_id: request.outcome_id.clone(),
        proposal_id: request.proposal.proposal_id.clone(),
        action_commitment,
        policy_bundle_id: request
            .bundle
            .as_ref()
            .map(|bundle| bundle.bundle_id.clone()),
        decision: MapDecision::Deny,
        reason_code: normalize_reason_code(reason_code),
        reason_detail: None,
        approval_id,
        receipt_required: request
            .bundle
            .as_ref()
            .map(|bundle| bundle.receipt_required)
            .unwrap_or(true),
        evaluated_at: request.evaluated_at.clone(),
    }
}

fn normalize_reason_code(value: &str) -> String {
    let candidate = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if candidate
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic())
    {
        candidate.chars().take(128).collect()
    } else {
        "kernel_denied".to_string()
    }
}

fn audience_intersects(left: &[String], right: &[String]) -> bool {
    left.iter()
        .any(|item| right.iter().any(|candidate| candidate == item))
}

fn has_matching_authority(
    bundle: &MapPolicyBundle,
    proposal: &MapActionProposal,
    now: i64,
) -> bool {
    bundle.authorities.iter().any(|authority| {
        authority.subject == proposal.actor
            && authority
                .actions
                .iter()
                .any(|action| action == &proposal.action)
            && audience_intersects(&authority.audience, &proposal.audience)
            && parse_rfc3339_epoch_seconds(&authority.valid_from)
                .is_ok_and(|valid_from| now >= valid_from)
            && authority
                .valid_until
                .as_ref()
                .map(|valid_until| {
                    parse_rfc3339_epoch_seconds(valid_until).is_ok_and(|until| now <= until)
                })
                .unwrap_or(true)
            && authority_limits_allow(authority, proposal)
    })
}

fn authority_limits_allow(authority: &MapAuthority, proposal: &MapActionProposal) -> bool {
    let Some(limit) = authority
        .limits
        .as_ref()
        .and_then(|value| value.get("per_action_usd"))
        .and_then(Value::as_f64)
    else {
        return true;
    };
    proposal
        .arguments
        .get("amount_usd")
        .and_then(Value::as_f64)
        .is_some_and(|amount| amount <= limit)
}

fn conditions_match(
    conditions: &Option<Value>,
    proposal: &MapActionProposal,
    authority_present: bool,
    effect: &MapDecision,
) -> bool {
    let Some(Value::Object(map)) = conditions else {
        return true;
    };
    for (key, expected) in map {
        let matched = match key.as_str() {
            "amount_usd_lte" => numeric_argument(proposal, "amount_usd")
                .zip(expected.as_f64())
                .is_some_and(|(actual, expected)| actual <= expected),
            "amount_usd_gt" => numeric_argument(proposal, "amount_usd")
                .zip(expected.as_f64())
                .is_some_and(|(actual, expected)| actual > expected),
            "authority_required" => expected.as_bool().is_some_and(|required| {
                if !required {
                    return true;
                }
                if effect == &MapDecision::Deny {
                    !authority_present
                } else {
                    authority_present
                }
            }),
            _ => false,
        };
        if !matched {
            return false;
        }
    }
    true
}

fn numeric_argument(proposal: &MapActionProposal, key: &str) -> Option<f64> {
    proposal.arguments.get(key).and_then(Value::as_f64)
}

fn validate_actor(value: &MapActor, path: &str) -> VetoCoreResult<()> {
    validate_id(&value.id, &format!("{path}.id"))
}

fn validate_id_list(values: &[String], path: &str) -> VetoCoreResult<()> {
    for (index, value) in values.iter().enumerate() {
        validate_id(value, &format!("{path}[{index}]"))?;
    }
    Ok(())
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
    let Some(first) = value.chars().next() else {
        return invalid_artifact(path, "must not be empty");
    };
    if !first.is_ascii_alphabetic() {
        return invalid_artifact(path, "must start with a letter");
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
        invalid_artifact(path, "must be sha256:<64 lowercase hex chars>")
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
        return invalid_artifact(path, "must not be empty");
    }
    if value.len() > max {
        return invalid_artifact(path, "exceeds maximum length");
    }
    if value.chars().all(allow) {
        Ok(())
    } else {
        invalid_artifact(path, "contains unsupported characters")
    }
}

fn invalid_artifact<T>(path: &str, message: &str) -> VetoCoreResult<T> {
    Err(VetoCoreError::InvalidArtifact {
        path: path.to_string(),
        message: message.to_string(),
    })
}

trait ReasonString {
    fn to_string_reason(&self) -> String;
}

impl ReasonString for VetoCoreError {
    fn to_string_reason(&self) -> String {
        match self {
            VetoCoreError::Verification(message) if message.contains("expired") => {
                "policy_bundle_expired".to_string()
            }
            VetoCoreError::Verification(message) if message.contains("not valid yet") => {
                "policy_bundle_not_yet_valid".to_string()
            }
            _ => "policy_bundle_invalid".to_string(),
        }
    }
}
