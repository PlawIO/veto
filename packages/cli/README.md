# veto-cli

Canonical Veto CLI for both interactive Studio and headless automation.

## Install

```bash
npm install -g veto-cli
```

## Usage

```bash
veto
veto studio
veto policy generate --tool approve_invoice --prompt "block approvals above 50" --save ./veto/rules/invoice.yaml
veto guard check --tool approve_invoice --args '{"amount":60}' --json
veto cloud login
```

## Compatibility

`veto-sdk` still exposes the legacy `veto` bin for compatibility, but `veto-cli` is the canonical package.
