# veto-cli

## 1.16.0

### Minor Changes

- [#142](https://github.com/VulnZap/veto/pull/142) [`e0b1fdc`](https://github.com/VulnZap/veto/commit/e0b1fdc1a26c627cf8736b79ca8d83a60dfdead0) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Launch unified CLI foundations with a new canonical `veto-cli` package, Ink-first Studio runtime on Node, and first-class headless commands.

  Highlights:

  - add shared CLI runner used by both `veto-cli` and `veto-sdk` compatibility path
  - make Studio default for `veto`, `veto studio`, `veto repl`, with `--legacy` support
  - add headless command suite (`policy generate|apply`, `guard check`, `cloud *`, `doctor`)
  - add renderer preference support for `ink` and improved fallback behavior
  - tighten generation behavior (no silent template fallback by default)

### Patch Changes

- Updated dependencies [[`e0b1fdc`](https://github.com/VulnZap/veto/commit/e0b1fdc1a26c627cf8736b79ca8d83a60dfdead0)]:
  - veto-sdk@1.16.0
