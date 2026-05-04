# 60-second denied call

Paste this after installing the SDK and creating local defaults:

```bash
npm install veto-sdk
npx --package veto-cli@latest veto init
node examples/60-second-denied-call/denied-call.mjs
```

The example starts with the public API:

```ts
import { protect } from "veto-sdk";
const safeTools = await protect(tools);
```

`npx --package veto-cli@latest veto init` creates strict local rules. The `bash` tool call with `rm -rf` is denied before the handler runs. No provider SDK or API key is required.
