# Verifying Veto images

BYOC runtime images (`veto-server`, `veto-operator`, `veto-dashboard`, `veto-frontend`, `veto-docs`) are released from the private platform repository. Use the `PlawIO/veto-platform` release-images workflow identity on release tags for those images:

```bash
VETO_PLATFORM_IDENTITY_RE='https://github.com/PlawIO/veto-platform/.github/workflows/release-images\\.ya?ml@refs/(heads/main|tags/.*)'
```

Public-repo-only artifacts, such as `veto-bash` when published as an image, use the public repository identity and are listed separately below. Do not use the public `PlawIO/veto` identity for `veto-server`.

## Auditor-grep commands for `veto-server`

Signature:

```bash
cosign verify ghcr.io/plawio/veto-server@sha256:... \
  --certificate-identity-regexp "$VETO_PLATFORM_IDENTITY_RE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

CycloneDX SBOM attestation:

```bash
cosign verify-attestation ghcr.io/plawio/veto-server@sha256:... \
  --type cyclonedx \
  --certificate-identity-regexp "$VETO_PLATFORM_IDENTITY_RE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

SPDX SBOM attestation:

```bash
cosign verify-attestation ghcr.io/plawio/veto-server@sha256:... \
  --type spdx \
  --certificate-identity-regexp "$VETO_PLATFORM_IDENTITY_RE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

SLSA provenance attestation:

```bash
cosign verify-attestation ghcr.io/plawio/veto-server@sha256:... \
  --type slsaprovenance \
  --certificate-identity-regexp "$VETO_PLATFORM_IDENTITY_RE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

OpenVEX attestation:

```bash
cosign verify-attestation ghcr.io/plawio/veto-server@sha256:... \
  --type openvex \
  --certificate-identity-regexp "$VETO_PLATFORM_IDENTITY_RE" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

If your cosign version uses predicate-type URIs instead of aliases, verify the equivalent predicate types: CycloneDX `https://cyclonedx.org/bom`, SPDX `https://spdx.dev/Document`, SLSA `https://slsa.dev/provenance/v1`, and OpenVEX `https://openvex.dev/ns/v0.2.0`.

## Image matrix

| Image                                      | Release identity                                                                                         | Required verification                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ghcr.io/plawio/veto-server@sha256:...`    | <code>PlawIO/veto-platform/.github/workflows/release-images.ya?ml@refs/(heads/main&#124;tags/.\*)</code> | signature + CycloneDX + SPDX + SLSA provenance + OpenVEX                                  |
| `ghcr.io/plawio/veto-operator@sha256:...`  | <code>PlawIO/veto-platform/.github/workflows/release-images.ya?ml@refs/(heads/main&#124;tags/.\*)</code> | signature + CycloneDX + SPDX + SLSA provenance + OpenVEX                                  |
| `ghcr.io/plawio/veto-dashboard@sha256:...` | <code>PlawIO/veto-platform/.github/workflows/release-images.ya?ml@refs/(heads/main&#124;tags/.\*)</code> | signature + CycloneDX + SPDX + SLSA provenance + OpenVEX                                  |
| `ghcr.io/plawio/veto-frontend@sha256:...`  | <code>PlawIO/veto-platform/.github/workflows/release-images.ya?ml@refs/(heads/main&#124;tags/.\*)</code> | signature + CycloneDX + SPDX + SLSA provenance + OpenVEX                                  |
| `ghcr.io/plawio/veto-docs@sha256:...`      | <code>PlawIO/veto-platform/.github/workflows/release-images.ya?ml@refs/(heads/main&#124;tags/.\*)</code> | signature + CycloneDX + SPDX + SLSA provenance + OpenVEX                                  |
| `ghcr.io/plawio/veto-bash@sha256:...`      | <code>PlawIO/veto/.github/workflows/.\*@refs/(heads/master&#124;tags/.\*)</code>                         | signature + available SBOM/provenance/VEX attestations from the public repo image release |

BYOC deployments should pin digests in Helm/Terraform/CDK. Do not deploy mutable tags in production.

## Admission policy limitations

The Kyverno and Sigstore policy examples enforce signature identity and the four required attestation predicate types where the controller API supports attestation checks. Policy-controller/Cosign versions differ in alias support; if aliases are not accepted, use the predicate-type URIs listed above. Some controllers verify attestation existence and identity but do not validate OpenVEX contents beyond predicate type without an additional CEL/CUE policy.
