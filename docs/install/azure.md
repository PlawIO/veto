```bash
terraform -chdir=terraform-modules/azurerm init && terraform -chdir=terraform-modules/azurerm apply -var='resource_group_name=my-rg' -var='cluster_name=my-aks' -var='license=...' -var='operator_digest=sha256:...' -var='server_digest=sha256:...' -var='dashboard_digest=sha256:...'
```

# Azure BYOC install

The Azure module targets an existing AKS cluster through caller-provided Kubernetes and Helm providers. It installs the Veto operator chart and creates the `VetoCluster` custom resource.

No Plaw tenant app, delegated admin, cross-tenant role assignment, or impersonation is created. Customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, env vars, and secrets remain in your Azure tenant/subscription.

Outbound is limited to `ghcr.io`, `license.veto.so`, optional `telemetry.veto.so` (disabled by default), and kube DNS/API as needed.
