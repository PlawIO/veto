---
"veto-sdk": minor
---

Add typed FeedRef / PipelineRef condition values and the content-addressable Pipeline DSL.

- `RuleCondition.value` now accepts tagged references (`{ kind: "feed" | "pipeline", ... }`) in addition to bare literals. Set-membership operators (`in`, `not_in`, `contains`, `not_contains`) resolve the reference against an injected `FeedProvider` at evaluation time, with `fail_open` / `fail_closed` / `last_known_good` fallback when the snapshot is missing or stale. Backward compatible — existing literal comparands are unchanged.
- New `pipeline-dsl` module exposes a Zod schema for declarative, content-addressable pipeline specs (`PipelineSpec`, `parsePipelineSpec`, `computePipelineId`, `verifyPipelineId`). The id is the sha256 of the canonicalized spec, so equivalent specs share one pipeline identity. Import via the dedicated subpath: `import { ... } from "veto-sdk/rules/pipeline-dsl"`. It is intentionally NOT re-exported from `veto-sdk/rules` so the rules barrel stays free of the optional `zod` peer dep.
- New `feed-provider` module exposes the `FeedProvider` interface and `InMemoryFeedProvider` reference implementation for tests and SDK-side use.
- `evaluateCondition` and `evaluateRulesLocally` take an optional `LocalEvalOptions { feedProvider?, now_ms? }`.
- `canonicalizeJson` (used internally by `computePipelineId`) now throws on non-plain objects (Date, Map, Set, RegExp, class instances) and on unserializable primitives (BigInt, Symbol, function) to prevent silent hash collisions. Pipeline specs validated by `PipelineSpecSchema` never contain such values; the guard hardens callers that bypass Zod.
