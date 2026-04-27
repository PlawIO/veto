---
"veto-sdk": patch
"veto": patch
---

Harden the decision-stream logger.

- Sanitize control chars and ANSI escapes in arg values + tool names so a multi-line tool input doesn't break the one-line-per-decision invariant.
- `\n` / `\t` are visualised as `\n` / `\t`; backslash-escape pass now runs on the original string so visualisation backslashes don't get doubled.
- Non-finite latency (`NaN`, `±Infinity`) renders as `-` instead of throwing.
- Honor `NO_COLOR` and `FORCE_COLOR` env-var conventions.
- Default `HH:MM:SS` field to UTC; `VETO_LOG_LOCALTIME=1` opts back into host time.
- New `BaseStreamLogger` base class — stream-mode detection is now `instanceof`-strict instead of duck-typed on the `streamDecision` attribute.
- Validator's `"Tool call blocked by local rule"` warn is now filtered locally by `StreamLogger` instead of suppressed cross-layer in `Veto`. Other loggers (Console, Memory, custom) see the warn unchanged.
- Compact-mode call portion hard-truncated to 80 chars so long calls can't push the latency column off-screen.
- Single arg formatter shared between compact + verbose modes.
