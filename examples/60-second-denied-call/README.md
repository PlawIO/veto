# 60-second denied call

Paste this after installing the SDK and creating local defaults:

```bash
npm i veto-sdk openai
npx veto init
node examples/60-second-denied-call/denied-call.mjs
```

The example starts with the public API:

```ts
import { protect } from "veto-sdk";
const safeTools = await protect(tools);
```

`npx veto init` creates strict local rules. The `bash` tool call with `rm -rf` is denied before the handler runs.
