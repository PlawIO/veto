"""
Rate limit evaluation against a set of RateLimitEntry rules.

Falls back to the built-in in-memory sliding window store when
no external store is provided.
"""

from typing import Optional, Protocol

from veto.rate_limiting.types import RateLimitEntry
from veto.rate_limiting.store import check_and_record as memory_check_and_record
from veto.utils.logger import Logger


class RateLimitStore(Protocol):
    def check_and_record(self, key: str, max_calls: int, window_ms: int) -> bool: ...
    def clear(self) -> None: ...


def build_scope_key(
    entry: RateLimitEntry,
    ctx: object,
    tool_name: str,
    logger: Logger,
    rule_id: Optional[str] = None,
) -> str:
    """Build a cache key from the rate limit scope and context."""
    scope_id: Optional[str] = None

    if entry.scope == "agent":
        scope_id = getattr(ctx, "agent_id", None)
    elif entry.scope == "user":
        scope_id = getattr(ctx, "user_id", None)
    elif entry.scope == "session":
        scope_id = getattr(ctx, "session_id", None)
    else:
        scope_id = "global"

    if scope_id is None:
        logger.warn(
            f"[veto] rate_limit scope '{entry.scope}' requires "
            f"{entry.scope}_id in context. Falling back to global."
        )
        scope_id = "global"

    prefix = f"{rule_id}:" if rule_id else ""
    return f"{prefix}{entry.scope}:{scope_id}:{tool_name}"


async def evaluate_rate_limits(
    rate_limits: list[RateLimitEntry],
    ctx: object,
    tool_name: str,
    logger: Logger,
    rule_id: Optional[str] = None,
    store: Optional[RateLimitStore] = None,
) -> Optional[str]:
    """Evaluate rate limits for a tool call.

    Returns None if all limits pass, or a denial reason string if
    any limit is exceeded.
    """
    check = store.check_and_record if store else memory_check_and_record

    for entry in rate_limits:
        key = build_scope_key(entry, ctx, tool_name, logger, rule_id)
        window_ms = entry.window_seconds * 1000
        try:
            allowed = check(key, entry.max_calls, window_ms)
            if not allowed:
                return (
                    f"Rate limit exceeded: max {entry.max_calls} calls "
                    f"per {entry.window_seconds}s (scope: {entry.scope})"
                )
        except Exception as err:
            logger.error("[veto] rate limit store error, failing closed", context={"err": str(err)})
            return "Rate limit check failed (fail-closed)"

    return None
