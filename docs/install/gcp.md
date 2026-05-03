```bash
terraform -chdir=terraform-modules/gcp init && terraform -chdir=terraform-modules/gcp apply -var='project_id=my-project' -var='cluster_name=my-gke' -var='location=us-central1' -var='license=...' -var='operator_digest=sha256:...' -var='server_digest=sha256:...' -var='dashboard_digest=sha256:...'
```

# GCP BYOC install

The GCP module targets an existing GKE cluster through caller-provided Kubernetes and Helm providers. It installs the Veto operator chart and creates the `VetoCluster` custom resource.

No Plaw service-account impersonation, cross-project IAM, or delegated admin is created. Customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, env vars, and secrets remain in your GCP project.

Outbound is limited to `ghcr.io`, `license.veto.so`, optional `telemetry.veto.so` (disabled by default), and kube DNS/API as needed.
