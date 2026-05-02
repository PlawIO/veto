# Veto BYOC on Azure

```bash
terraform init && terraform apply -var='resource_group_name=my-rg' -var='cluster_name=my-aks' -var='license=...' -var='operator_digest=sha256:...' -var='server_digest=sha256:...' -var='dashboard_digest=sha256:...'
```

This module installs the public `oci://ghcr.io/plawio/charts/veto-operator` chart into an existing AKS cluster through caller-provided Kubernetes and Helm providers, then creates a `VetoCluster` custom resource.

Contract:

- no Plaw tenant app, delegated admin, cross-tenant role assignment, or impersonation is created
- outbound allowlist defaults to `ghcr.io`, `license.veto.so`, and `telemetry.veto.so`; telemetry is disabled by default
- customer policy, decisions, tool args, identities, Slack content, prompts, env vars, and secrets remain in the customer Azure tenant/subscription
