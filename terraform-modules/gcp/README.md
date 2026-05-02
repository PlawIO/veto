# Veto BYOC on GCP

```bash
terraform init && terraform apply -var='project_id=my-project' -var='cluster_name=my-gke' -var='location=us-central1' -var='license=...' -var='operator_digest=sha256:...' -var='server_digest=sha256:...' -var='dashboard_digest=sha256:...'
```

This module installs the public `oci://ghcr.io/plawio/charts/veto-operator` chart into an existing GKE cluster through caller-provided Kubernetes and Helm providers, then creates a `VetoCluster` custom resource.

Contract:

- no Plaw service-account impersonation, Workload Identity binding, or cross-project IAM is created
- outbound allowlist defaults to `ghcr.io`, `license.veto.so`, and `telemetry.veto.so`; telemetry is disabled by default
- customer policy, decisions, tool args, identities, Slack content, prompts, env vars, and secrets remain in the customer GCP project
