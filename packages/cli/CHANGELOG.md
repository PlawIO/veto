# veto-cli

## 1.16.8

### Patch Changes

- Updated dependencies [[`8c5e643`](https://github.com/PlawIO/veto/commit/8c5e643f7090edeb387ac1d50156d9cac044f20e)]:
  - veto-sdk@2.2.2

## 1.16.7

### Patch Changes

- Updated dependencies [[`daa2464`](https://github.com/PlawIO/veto/commit/daa2464ca26481ffc2d7bd98864385f75d428286)]:
  - veto-sdk@2.2.1

## 1.16.6

### Patch Changes

- Updated dependencies [[`f2d8948`](https://github.com/PlawIO/veto/commit/f2d89482af05ee0da186d0a4eaa527a4b9f4f0d0)]:
  - veto-sdk@2.2.0

## 1.16.5

### Patch Changes

- Updated dependencies [[`f606cde`](https://github.com/PlawIO/veto/commit/f606cdef590530e989b9cdebaa0f22b632a854ac)]:
  - veto-sdk@2.1.1

## 1.16.4

### Patch Changes

- Updated dependencies [[`7207342`](https://github.com/PlawIO/veto/commit/720734208c5b8a783e461a253691aded148dcba6)]:
  - veto-sdk@2.1.0

## 1.16.3

### Patch Changes

- Updated dependencies [[`0a2873e`](https://github.com/PlawIO/veto/commit/0a2873e4e89c9ca3bd910341dd50657154fedaa3), [`d2f4c12`](https://github.com/PlawIO/veto/commit/d2f4c121ebd8e1839087f05464f7ce9972fbd577)]:
  - veto-sdk@2.0.0

## 1.16.2

### Patch Changes

- [#146](https://github.com/VulnZap/veto/pull/146) [`69af93e`](https://github.com/VulnZap/veto/commit/69af93e47886394a92f6000a1ab4585b00d0fd94) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add MCP gateway CLI commands (`veto mcp serve`, `veto mcp doctor`, `veto mcp init`) and harden transport, URL, and API key validation for safer defaults.

- Updated dependencies [[`69af93e`](https://github.com/VulnZap/veto/commit/69af93e47886394a92f6000a1ab4585b00d0fd94)]:
  - veto-sdk@1.17.0

## 1.16.1

### Patch Changes

- [#144](https://github.com/VulnZap/veto/pull/144) [`1f4eca1`](https://github.com/VulnZap/veto/commit/1f4eca107a62d7fe1a2490e149d45c1ab8a95513) Thanks [@yazcaleb](https://github.com/yazcaleb)! - fix(cli): lazy-load Studio renderers so Ink import failures fall back to ANSI instead of crashing on startup (for example on Node 22.12).

- Updated dependencies [[`1f4eca1`](https://github.com/VulnZap/veto/commit/1f4eca107a62d7fe1a2490e149d45c1ab8a95513)]:
  - veto-sdk@1.16.1

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
