# @veto/python-release

## 0.5.1

### Patch Changes

- [#197](https://github.com/PlawIO/veto/pull/197) [`da432af`](https://github.com/PlawIO/veto/commit/da432afe7de659bad31a2686760030a5c4c76149) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add starter compliance policy packs, public built-in pack registry helpers, and clearer custom provider API-key resolution/retry errors.

  Add create-veto-app for scaffolding minimal TypeScript Veto agent projects.

## 0.5.0

### Minor Changes

- [#188](https://github.com/PlawIO/veto/pull/188) [`29c5123`](https://github.com/PlawIO/veto/commit/29c512337b7db8b7590c14f395706d9e97c11c70) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add an aiohttp-based Python proxy server with OpenAI and Anthropic SSE interception helpers.

### Patch Changes

- [#190](https://github.com/PlawIO/veto/pull/190) [`c76d142`](https://github.com/PlawIO/veto/commit/c76d142d8273a0a3ea526847c8ed71ebe29c0717) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix MCP connect no-op rewrites and Python admin SSE streaming behavior.

## 0.4.0

### Minor Changes

- [#185](https://github.com/PlawIO/veto/pull/185) [`bd8c579`](https://github.com/PlawIO/veto/commit/bd8c579124fc98fbac6e676b8a1886b10d8bda17) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Port `VetoAdmin` to the Python SDK with async admin management client support matching the TypeScript admin surface.

## 0.3.1

### Patch Changes

- [#165](https://github.com/PlawIO/veto/pull/165) [`f606cde`](https://github.com/PlawIO/veto/commit/f606cdef590530e989b9cdebaa0f22b632a854ac) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Fix decision stream logging in the TypeScript and Python protect helpers, preserve stream-aware cache separation, and keep operational warnings visible in stream mode.

## 0.3.0

### Minor Changes

- [#129](https://github.com/VulnZap/veto/pull/129) [`4ccb94c`](https://github.com/VulnZap/veto/commit/4ccb94cd5bcb3a873ae9656eb1a9c029eb008b82) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add true `shadow` mode to TypeScript and Python SDKs so wrapped calls never block while preserving real decisions and emitting shadow telemetry.

## 0.2.0

### Minor Changes

- [#127](https://github.com/VulnZap/veto/pull/127) [`d5e7aeb`](https://github.com/VulnZap/veto/commit/d5e7aebb192ce73ec9cc333272dd33cae976f356) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add default policy auto-apply enhancements in `protect()` with new `communication` and `deployment` policy packs, expanded tool-name heuristics, auto-apply stderr transparency, and `length_greater_than` condition support across TypeScript and Python SDKs.

## 0.1.0

### Minor Changes

- [#126](https://github.com/VulnZap/veto/pull/126) [`521d540`](https://github.com/VulnZap/veto/commit/521d540bfbc80995c94438db7ad3e83be3882f04) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a top-level async `protect()` one-liner API to TypeScript and Python SDKs.

  Highlights:

  - Introduce `protect()` as the primary onboarding entrypoint (`protect(tools)` and `protect(tool)`).
  - Add source auto-detection (rules/api key/endpoint/config/local), heuristic pack selection, and allow-all fallback.
  - Add module-level instance caching so repeated calls reuse initialized Veto state when options match.
  - Add browser entrypoint support for `protect()` with safe allow-all fallback behavior.
  - Add Python `Veto.from_rules()` parity helper and top-level `protect` export.
