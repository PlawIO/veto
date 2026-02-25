---
"veto-sdk": minor
"veto-cli": minor
---

Launch unified CLI foundations with a new canonical `veto-cli` package, Ink-first Studio runtime on Node, and first-class headless commands.

Highlights:

- add shared CLI runner used by both `veto-cli` and `veto-sdk` compatibility path
- make Studio default for `veto`, `veto studio`, `veto repl`, with `--legacy` support
- add headless command suite (`policy generate|apply`, `guard check`, `cloud *`, `doctor`)
- add renderer preference support for `ink` and improved fallback behavior
- tighten generation behavior (no silent template fallback by default)
