# veto

[![npm](https://img.shields.io/npm/v/veto?color=000000)](https://www.npmjs.com/package/veto)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

Canonical npm CLI package for Veto. This is the package behind `npx veto init`.

## Use without installing

```bash
npx veto init
```

## Install globally

```bash
npm install -g veto
veto init
```

## Local policy quick start

```bash
npm install veto-sdk
npx veto init
```

Then wrap your tools with the SDK:

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
```

`veto` is a thin wrapper around shared CLI logic exported from `veto-sdk/cli-runner`; CLI behavior lives in `veto-sdk`.

`veto-cli` and `veto-sdk` still expose a `veto` bin as compatibility paths for existing users. New docs and installs should use `veto`.

## License

Apache-2.0
