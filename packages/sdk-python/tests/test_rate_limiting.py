"""Tests for rate limiting store and evaluator."""

import pytest

from veto.rate_limiting.store import check_and_record, clear_store
from veto.rate_limiting.evaluator import (
    build_scope_key,
    evaluate_rate_limits,
)
from veto.rate_limiting.types import RateLimitEntry
from veto.utils.logger import create_logger


@pytest.fixture(autouse=True)
def _clean_store():
    """Reset the in-memory store between tests."""
    clear_store()
    yield
    clear_store()


class TestCheckAndRecord:
    def test_allows_within_limit(self):
        assert check_and_record("k", 3, 60_000) is True
        assert check_and_record("k", 3, 60_000) is True
        assert check_and_record("k", 3, 60_000) is True

    def test_blocks_over_limit(self):
        for _ in range(5):
            check_and_record("k", 5, 60_000)
        assert check_and_record("k", 5, 60_000) is False

    def test_separate_keys_independent(self):
        for _ in range(3):
            check_and_record("a", 3, 60_000)
        assert check_and_record("a", 3, 60_000) is False
        assert check_and_record("b", 3, 60_000) is True


class TestBuildScopeKey:
    def test_global_scope(self):
        logger = create_logger("silent")
        entry = RateLimitEntry(scope="global", max_calls=10, window_seconds=60)

        class Ctx:
            agent_id = None
            user_id = None
            session_id = None

        key = build_scope_key(entry, Ctx(), "read_file", logger)
        assert key == "global:global:read_file"

    def test_agent_scope(self):
        logger = create_logger("silent")
        entry = RateLimitEntry(scope="agent", max_calls=10, window_seconds=60)

        class Ctx:
            agent_id = "agent-1"
            user_id = None
            session_id = None

        key = build_scope_key(entry, Ctx(), "read_file", logger)
        assert key == "agent:agent-1:read_file"

    def test_missing_scope_id_falls_back_to_global(self):
        logger = create_logger("silent")
        entry = RateLimitEntry(scope="user", max_calls=10, window_seconds=60)

        class Ctx:
            agent_id = None
            user_id = None
            session_id = None

        key = build_scope_key(entry, Ctx(), "read_file", logger)
        assert key == "user:global:read_file"

    def test_rule_id_prefix(self):
        logger = create_logger("silent")
        entry = RateLimitEntry(scope="global", max_calls=10, window_seconds=60)

        class Ctx:
            agent_id = None
            user_id = None
            session_id = None

        key = build_scope_key(entry, Ctx(), "read_file", logger, rule_id="rule-1")
        assert key == "rule-1:global:global:read_file"


class TestEvaluateRateLimits:
    @pytest.mark.asyncio
    async def test_allows_within_limit(self):
        logger = create_logger("silent")
        limits = [RateLimitEntry(scope="global", max_calls=5, window_seconds=60)]

        class Ctx:
            agent_id = None
            user_id = None
            session_id = None

        result = await evaluate_rate_limits(limits, Ctx(), "tool", logger)
        assert result is None

    @pytest.mark.asyncio
    async def test_denies_over_limit(self):
        logger = create_logger("silent")
        limits = [RateLimitEntry(scope="global", max_calls=2, window_seconds=60)]

        class Ctx:
            agent_id = None
            user_id = None
            session_id = None

        ctx = Ctx()
        await evaluate_rate_limits(limits, ctx, "tool", logger)
        await evaluate_rate_limits(limits, ctx, "tool", logger)
        result = await evaluate_rate_limits(limits, ctx, "tool", logger)
        assert result is not None
        assert "Rate limit exceeded" in result

    @pytest.mark.asyncio
    async def test_fail_closed_on_store_error(self):
        logger = create_logger("silent")
        limits = [RateLimitEntry(scope="global", max_calls=10, window_seconds=60)]

        class BrokenStore:
            def check_and_record(self, key: str, max_calls: int, window_ms: int) -> bool:
                raise RuntimeError("store down")

            def clear(self) -> None:
                pass

        class Ctx:
            agent_id = None
            user_id = None
            session_id = None

        result = await evaluate_rate_limits(
            limits, Ctx(), "tool", logger, store=BrokenStore()
        )
        assert result == "Rate limit check failed (fail-closed)"
