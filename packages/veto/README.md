# veto

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

Local unpublished Veto CLI wrapper reserved for the future canonical package once Plaw controls the `veto` npm name.

This package is not published while the `veto` npm name is externally owned. Do not install or run the unscoped npm package yet.

## Use without installing

```bash
npx --package veto-cli@latest veto init
```

Analogous commands should use the owned `veto-cli` package form:

```bash
npx --package veto-cli@latest veto policy generate --tool bash --prompt "block rm -rf" --save ./veto/rules/block-rm-rf.yaml
npx --package veto-cli@latest veto install claude-code
```

## Local policy quick start

```bash
npm install veto-sdk
npx --package veto-cli@latest veto init
```

Then wrap your tools with the SDK:

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
```

`veto` is a thin local wrapper around shared CLI logic exported from `veto-sdk/cli-runner`; CLI behavior lives in `veto-sdk`.

The build and bin definitions remain intact for local workspace builds and tests. `veto-cli` and `veto-sdk` still expose a `veto` bin as compatibility paths for existing users. Public docs and installs should use `npx --package veto-cli@latest veto ...` until the `veto` npm name is transferred.

## License

Apache-2.0
