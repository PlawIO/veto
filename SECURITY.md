# Security Policy

## Supported versions

Security patches are applied to the latest release of each package. Older versions are not backported.

| Package | Supported |
|---------|-----------|
| `veto-sdk` (latest) | Yes |
| `veto` Python SDK (latest) | Yes |
| `veto-cli` (latest) | Yes |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email [security@plaw.io](mailto:security@plaw.io) with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

We will acknowledge your report within **2 business days** and aim to ship a fix within **14 days** of confirmation. We'll credit you in the release notes unless you prefer to remain anonymous.

## Scope

**In scope:**

- Policy bypass — any way for an agent to execute an action that your rules should block
- Authentication or authorization flaws in Veto Cloud
- Dependency vulnerabilities with a demonstrable exploit path in Veto packages
- Data leakage from the decision audit log

**Out of scope:**

- Vulnerabilities in the underlying AI model (report those to the model provider)
- Social engineering attacks
- Denial-of-service against your own local Veto instance
- Issues only reproducible on unsupported/EOL versions

## Disclosure policy

We follow coordinated disclosure. Please give us reasonable time to fix the issue before publishing. We will work with you to agree on a public disclosure date.
