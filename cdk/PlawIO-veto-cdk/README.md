# @plawio/veto-cdk

```ts
new VetoCluster(this, "veto", { license: "..." });
```

To install into EKS, pass an existing `eks.ICluster` and image digests:

```ts
new VetoCluster(this, "veto", {
  cluster,
  license: process.env.VETO_LICENSE!,
  operatorDigest: "sha256:...",
  serverDigest: "sha256:...",
  dashboardDigest: "sha256:...",
});
```

The construct installs `oci://ghcr.io/plawio/charts/veto-operator` and creates no Plaw cross-account IAM, external IDs, roles, or impersonation. Outbound hosts default to `ghcr.io`, `license.veto.so`, and `telemetry.veto.so`; telemetry is disabled by default. Customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, environment variables, and secrets stay in the customer AWS account.
