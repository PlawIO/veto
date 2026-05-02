# create-veto-app

Scaffold a minimal TypeScript app that starts with `protect(tools)`.

```bash
npm create veto-app -- my-agent --template node-ts --pack soc2-lite --yes
# or
npx create-veto-app my-agent --template node-ts --pack soc2-lite --yes
```

The scaffolder creates a tiny Node + TypeScript project, runs `veto init` for local Veto config/rules, and does not run package installation. No `node_modules` or lockfiles are generated.

## Options

```bash
create-veto-app <project-dir> [--template node-ts] [--pack <name>] [--cloud] [--api-key <key>] [--yes] [--no-install]
```

- `--template node-ts`: supported starter template.
- `--pack <name>`: `none`, `default`, or a built-in Veto pack such as `soc2-lite`.
- `--cloud`: generate `veto/veto.config.yaml` for Veto Cloud API mode.
- `--api-key <key>`: writes the key to `veto/veto.config.yaml` and ignores that file in `.gitignore`. Prefer environment variables for shared projects.
- `--yes`: non-interactive mode. A project directory is required.
- `--no-install`: accepted for compatibility; installs are not run by default.

Starter compliance packs are policy templates operators must review and tune. They do not make an app compliant.

Generated apps use the public SDK entrypoint first:

```ts
import { protect } from "veto-sdk";

const safeTools = await protect(tools);
```
