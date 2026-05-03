```bash
helm upgrade --install veto oci://ghcr.io/plawio/charts/veto-operator --namespace veto-system --create-namespace --set license='...' --set images.operator.digest='sha256:...' --set images.server.digest='sha256:...' --set images.dashboard.digest='sha256:...' --set telemetry.enabled=false
```

# Kubernetes install

This installs CRDs, operator, server, dashboard, and default-deny egress policy into your cluster. The chart uses image digests, not mutable tags.

Outbound-only boundary:

- allowed outbound hosts: `ghcr.io`, `license.veto.so`, and `telemetry.veto.so`
- telemetry is disabled by default
- kube DNS/API egress is allowed only as needed for cluster operation
- no customer policy, decision rows, tool args, agent IDs, user IDs, Slack content, prompts, env vars, or secrets cross to Plaw

If your cluster does not support Cilium FQDN policies, disable `networkPolicy.fqdn.enabled` and provide equivalent egress controls through your CNI/firewall.
