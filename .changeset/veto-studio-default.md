---
"veto-sdk": minor
---

Launch Veto Studio as the default interactive experience for `veto repl` and `veto --repl`, while preserving legacy line REPL compatibility behind `--legacy`.

### Added

- New full-screen Studio workflow with keyboard-first navigation, command palette, policy wizard, simulation, and review/save flow.
- Renderer selection with `--renderer <auto|opentui|ansi>` and automatic OpenTUI -> ANSI runtime fallback.
- Workspace and scan scope controls:
  - `--directory <path>`
  - `--include-examples`
  - `--include-tests`
- Studio configuration support in `veto.config.yaml` under `studio.workspace`, `studio.generation`, and `studio.renderer`.
- Generation connectivity checks and explicit fallback gate (`--demo-template` / `studio.generation.allowTemplateFallback`).

### Changed

- `veto repl` and `veto --repl` now default to Studio.
- `veto scan` now correctly honors `--directory` and include/exclude scope flags.
- Natural-language intent handling for negated approval prompts now defaults to `block` (e.g. `"do not approve invoices above 50"`).
- CLI version banner/help now use runtime package version (no hardcoded `0.1.0`).
