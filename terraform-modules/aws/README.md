# Veto BYOC on AWS

```bash
terraform init && terraform apply -var='cluster_name=my-eks' -var='license=...' -var='operator_digest=sha256:...' -var='server_digest=sha256:...' -var='dashboard_digest=sha256:...'
```

This module installs the public `oci://ghcr.io/plawio/charts/veto-operator` chart into an existing EKS cluster through the caller-provided Kubernetes and Helm providers, then creates a `VetoCluster` custom resource.

Contract:

- creates namespace, Helm release, and VetoCluster only
- does not create Plaw cross-account IAM, external IDs, roles, or impersonation
- outbound allowlist defaults to `ghcr.io`, `license.veto.so`, and `telemetry.veto.so`; telemetry is disabled by default
- customer policy, decisions, tool args, identities, Slack content, prompts, env vars, and secrets remain in the customer AWS account
