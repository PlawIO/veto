```bash
terraform -chdir=terraform-modules/aws init && terraform -chdir=terraform-modules/aws apply -var='cluster_name=my-eks' -var='license=...' -var='operator_digest=sha256:...' -var='server_digest=sha256:...' -var='dashboard_digest=sha256:...'
```

# AWS BYOC install

Use the Terraform module for existing EKS clusters, or the CloudFormation runbook path:

```bash
aws cloudformation deploy --stack-name veto-byoc --template-file cf-templates/veto-byoc.yaml --parameter-overrides ClusterName=my-eks License='...' OperatorDigest=sha256:... ServerDigest=sha256:... DashboardDigest=sha256:...
```

The AWS artifacts create no Plaw cross-account IAM, external IDs, roles, or impersonation. They install Veto into your customer-owned EKS cluster and keep customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, env vars, and secrets in your AWS account.

Outbound is limited to `ghcr.io`, `license.veto.so`, optional `telemetry.veto.so` (disabled by default), and kube DNS/API as needed.
