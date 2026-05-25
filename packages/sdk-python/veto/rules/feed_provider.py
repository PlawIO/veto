"""Feed provider utilities for local rule evaluation.

The platform owns pipeline scheduling and persistence. The SDK only needs a
small synchronous provider interface so local evaluation can resolve feed- or
pipeline-backed condition values without making network calls.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any, Literal, Protocol

FeedFallback = Literal["fail_open", "fail_closed", "last_known_good"]


@dataclass
class FeedSnapshot:
    """Resolved feed snapshot returned by a provider."""

    data: list[Any]
    refreshed_at_ms: float
    version: str | None = None


class FeedProvider(Protocol):
    """Read-only feed-snapshot provider."""

    def get(self, feed_id: str, version: str | None = None) -> FeedSnapshot | None:
        ...


class InMemoryFeedProvider:
    """Simple in-memory provider for tests and single-process SDK users."""

    def __init__(self) -> None:
        self._store: dict[str, FeedSnapshot] = {}

    def put(self, feed_id: str, snapshot: FeedSnapshot) -> None:
        self._store[feed_id] = snapshot

    def get(self, feed_id: str, version: str | None = None) -> FeedSnapshot | None:
        return self._store.get(feed_id)

    def clear(self) -> None:
        self._store.clear()

    def size(self) -> int:
        return len(self._store)


def is_condition_value_ref(value: Any) -> bool:
    """Return True for tagged FeedRef/PipelineRef condition values."""
    return isinstance(value, dict) and value.get("kind") in ("feed", "pipeline")


def _fallback(ref: dict[str, Any]) -> dict[str, FeedFallback]:
    return {
        "fallback": "fail_closed"
        if ref.get("fallback") == "fail_closed"
        else "fail_open"
    }


def resolve_feed_ref(
    ref: dict[str, Any],
    provider: FeedProvider | None,
    now_ms: float | None = None,
) -> dict[str, Any]:
    """Resolve a FeedRef/PipelineRef into an array comparand.

    Returns ``{"resolved": [...]}`` on hit or
    ``{"fallback": "fail_open" | "fail_closed"}`` on miss/stale.
    """
    if provider is None:
        return _fallback(ref)

    feed_id = ref.get("feed_id") if ref.get("kind") == "feed" else ref.get("pipeline_id")
    if not isinstance(feed_id, str) or not feed_id:
        return _fallback(ref)

    version = ref.get("version")
    snapshot = provider.get(feed_id, version if isinstance(version, str) else None)
    if snapshot is None:
        return _fallback(ref)

    check_ms = now_ms if now_ms is not None else time.time() * 1000
    if not math.isfinite(check_ms) or not math.isfinite(snapshot.refreshed_at_ms):
        if ref.get("fallback") == "last_known_good":
            return {"resolved": snapshot.data}
        return _fallback(ref)

    max_staleness_sec = ref.get("max_staleness_sec")
    if not isinstance(max_staleness_sec, (int, float)) or isinstance(
        max_staleness_sec, bool
    ):
        return _fallback(ref)

    age_sec = max(0, int((check_ms - snapshot.refreshed_at_ms) / 1000))
    stale = age_sec > max_staleness_sec
    if stale and ref.get("fallback") != "last_known_good":
        return _fallback(ref)

    return {"resolved": snapshot.data}

