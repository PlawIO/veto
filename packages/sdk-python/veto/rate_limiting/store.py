"""
In-process sliding window rate limit store.

Stores call timestamps per key. Thread-safe via threading.Lock.
Process-local only; resets on restart.
"""

import threading
import time

_store: dict[str, list[float]] = {}
_lock = threading.Lock()


def check_and_record(key: str, max_calls: int, window_ms: int) -> bool:
    """Check if a call is allowed and record it if so.

    Returns True if allowed, False if rate limited.
    """
    now = time.monotonic() * 1000
    with _lock:
        prev = _store.get(key, [])
        valid = [t for t in prev if now - t < window_ms]
        if len(valid) >= max_calls:
            return False
        valid.append(now)
        _store[key] = valid
    return True


def clear_store() -> None:
    """Clear all rate limit state."""
    with _lock:
        _store.clear()
