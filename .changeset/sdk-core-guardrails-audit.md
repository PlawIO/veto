---
"veto-sdk": patch
---

Harden SDK cache reuse and internal snapshot behavior.

- prevent `protect()` from reusing stale default/cached instances across incompatible policy and approval-callback contexts
- stop invalidated cloud policy cache entries from being repopulated by stale background refreshes
- return immutable history snapshots so callers cannot mutate internal Veto history state
- align browser-side protect caching with the Node runtime behavior
