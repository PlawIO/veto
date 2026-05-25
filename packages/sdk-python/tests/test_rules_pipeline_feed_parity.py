from datetime import datetime, timezone

import pytest

from veto import (
    FeedSnapshot,
    InMemoryFeedProvider,
    LocalEvalOptions,
    canonicalize_json,
    compute_pipeline_id,
    evaluate_rules_locally,
    parse_pipeline_spec,
    stamp_pipeline_id,
    verify_pipeline_id,
)
from veto.rules.condition_evaluator import evaluate_condition


def _draft_pipeline() -> dict:
    return {
        "dsl_version": 1,
        "description": "Find gambling domains",
        "schedule": {"kind": "interval", "every_sec": 3600},
        "steps": [
            {
                "kind": "search",
                "resolver": "exa",
                "query": "gambling sites sportsbook casino",
                "limit": 25,
                "as": "raw",
            },
            {"kind": "aggregate", "source": "raw", "op": "unique", "as": "urls"},
        ],
        "output": {"shape": "list_of_strings"},
        "budget": {
            "max_resolver_calls_per_run": 2,
            "max_tokens_per_run": 1000,
        },
        "on_failure": "last_known_good",
    }


def test_pipeline_dsl_stamps_and_verifies_content_hash() -> None:
    stamped = stamp_pipeline_id(_draft_pipeline())
    parsed = parse_pipeline_spec(stamped)

    assert parsed["id"] == compute_pipeline_id(parsed)
    assert verify_pipeline_id(parsed)
    assert len(parsed["id"]) == 64


def test_pipeline_canonicalization_is_key_order_stable() -> None:
    assert canonicalize_json({"b": 1, "a": [2, {"z": True}]}) == canonicalize_json(
        {"a": [2, {"z": True}], "b": 1}
    )


def test_pipeline_parser_rejects_nested_foreach() -> None:
    spec = {
        **_draft_pipeline(),
        "steps": [
            {
                "kind": "foreach",
                "source": "raw",
                "do": [
                    {
                        "kind": "foreach",
                        "source": "nested",
                        "do": [{"kind": "aggregate", "source": "x", "op": "unique"}],
                    }
                ],
            }
        ],
    }
    spec["id"] = compute_pipeline_id(spec)

    with pytest.raises(ValueError):
        parse_pipeline_spec(spec)


def _feed_ref(**overrides: object) -> dict:
    return {
        "kind": "feed",
        "feed_id": "gambling-sites",
        "version": "latest",
        "max_staleness_sec": 60,
        "fallback": "fail_open",
        **overrides,
    }


def test_feed_refs_work_in_conditions() -> None:
    provider = InMemoryFeedProvider()
    provider.put(
        "gambling-sites",
        FeedSnapshot(
            data=["casino.example", "sportsbook.example"],
            refreshed_at_ms=1_000_000,
        ),
    )

    condition = {
        "field": "arguments.url",
        "operator": "in",
        "value": _feed_ref(),
    }
    assert evaluate_condition(
        condition,
        {"arguments": {"url": "casino.example"}},
        now=datetime.fromtimestamp(1_010, tz=timezone.utc),
        feed_provider=provider,
    )
    assert not evaluate_condition(
        condition,
        {"arguments": {"url": "news.example"}},
        now=datetime.fromtimestamp(1_010, tz=timezone.utc),
        feed_provider=provider,
    )


def test_feed_ref_fallbacks_match_ts_semantics() -> None:
    condition = {"field": "arguments.url", "operator": "in", "value": _feed_ref()}
    assert not evaluate_condition(condition, {"arguments": {"url": "x"}})

    fail_closed = {
        "field": "arguments.url",
        "operator": "in",
        "value": _feed_ref(fallback="fail_closed"),
    }
    assert evaluate_condition(fail_closed, {"arguments": {"url": "x"}})


def test_local_evaluator_accepts_feed_provider() -> None:
    provider = InMemoryFeedProvider()
    provider.put(
        "gambling-sites",
        FeedSnapshot(data=["casino.example"], refreshed_at_ms=1_000_000),
    )
    result = evaluate_rules_locally(
        [
            {
                "id": "block-feed-url",
                "name": "Block feed URL",
                "enabled": True,
                "action": "block",
                "tools": ["browser_go_to_url"],
                "conditions": [
                    {
                        "field": "arguments.url",
                        "operator": "in",
                        "value": _feed_ref(),
                    }
                ],
            }
        ],
        "browser_go_to_url",
        {"arguments": {"url": "casino.example"}},
        LocalEvalOptions(
            feed_provider=provider,
            now=datetime.fromtimestamp(1_010, tz=timezone.utc),
        ),
    )

    assert result.decision == "deny"
    assert result.rule_id == "block-feed-url"


def test_new_condition_operators_match_ts_surface() -> None:
    context = {"arguments": {"amount": 100, "limit": 200}}
    assert evaluate_condition(
        {"field": "arguments.amount", "operator": "greater_than_or_equal", "value": 100},
        context,
    )
    assert evaluate_condition(
        {"field": "arguments.amount", "operator": "less_than_or_equal", "value": 100},
        context,
    )
    assert evaluate_condition(
        {
            "field": "arguments.amount",
            "operator": "percent_of",
            "value": 40,
            "reference": "arguments.limit",
        },
        context,
    )
    assert evaluate_condition(
        {"field": "arguments.missing", "operator": "not_exists"},
        context,
    )
    assert not evaluate_condition(
        {"field": "arguments.missing", "operator": "equals", "value": None},
        context,
    )
