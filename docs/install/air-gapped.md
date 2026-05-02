```bash
helm upgrade --install veto ./bundle/charts/veto-operator --namespace veto-system --create-namespace --set license='...' --set global.imageRegistry='registry.local/plawio' --set telemetry.enabled=false
```

# Air-gapped install scaffold

This is the documented scaffold for the later automated bundle task. The intended bundle contains:

- Helm chart `veto-operator`
- CRDs
- signed images mirrored by digest into the customer registry
- SBOMs, provenance attestations, and cosign public-key material
- offline license file or customer-hosted license endpoint

No customer data leaves the air-gapped environment. Policy, decisions, tool args, agent IDs, user IDs, Slack content, prompts, env vars, and secrets remain local. Telemetry is disabled and no Plaw cross-account IAM/impersonation exists.
