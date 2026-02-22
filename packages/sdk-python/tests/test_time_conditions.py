from datetime import datetime, timezone

from veto.rules import evaluate_condition


def test_outside_hours_matches_off_hours() -> None:
    condition = {
        "field": "context.time",
        "operator": "outside_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "UTC",
        },
    }

    matched = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 6, 22, 0, tzinfo=timezone.utc),
    )

    assert matched is True


def test_within_hours_matches_working_hours() -> None:
    condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "UTC",
        },
    }

    matched = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 6, 10, 30, tzinfo=timezone.utc),
    )

    assert matched is True


def test_timezone_conversion_is_applied_before_matching() -> None:
    now = datetime(2025, 1, 6, 18, 30, tzinfo=timezone.utc)

    los_angeles_condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "America/Los_Angeles",
        },
    }

    tokyo_condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "Asia/Tokyo",
        },
    }

    assert evaluate_condition(los_angeles_condition, context={}, now=now) is True
    assert evaluate_condition(tokyo_condition, context={}, now=now) is False


def test_weekday_filters_limit_evaluation_scope() -> None:
    condition = {
        "field": "context.time",
        "operator": "outside_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "UTC",
            "days": ["mon", "tue", "wed", "thu", "fri"],
        },
    }

    saturday_off_hours = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 11, 22, 0, tzinfo=timezone.utc),
    )

    assert saturday_off_hours is False


def test_context_day_of_week_works_with_in_operator() -> None:
    condition = {
        "field": "context.day_of_week",
        "operator": "in",
        "value": ["sat", "sun"],
    }

    saturday_match = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 11, 12, 0, tzinfo=timezone.utc),
    )
    monday_match = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 13, 12, 0, tzinfo=timezone.utc),
    )

    assert saturday_match is True
    assert monday_match is False


def test_days_omitted_applies_every_day() -> None:
    condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "UTC",
        },
    }

    sunday_match = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 12, 10, 0, tzinfo=timezone.utc),
    )

    assert sunday_match is True


def test_overnight_windows_cross_midnight() -> None:
    condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "22:00",
            "end": "06:00",
            "timezone": "UTC",
        },
    }

    late_night = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 6, 23, 30, tzinfo=timezone.utc),
    )
    early_morning = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 7, 3, 30, tzinfo=timezone.utc),
    )
    daytime = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 7, 12, 0, tzinfo=timezone.utc),
    )

    assert late_night is True
    assert early_morning is True
    assert daytime is False


def test_overnight_day_filters_apply_to_window_start_day() -> None:
    condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "22:00",
            "end": "06:00",
            "timezone": "UTC",
            "days": ["fri"],
        },
    }

    saturday_early_morning = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 11, 3, 0, tzinfo=timezone.utc),
    )
    sunday_early_morning = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 12, 3, 0, tzinfo=timezone.utc),
    )

    assert saturday_early_morning is True
    assert sunday_early_morning is False


def test_invalid_timezone_returns_false() -> None:
    condition = {
        "field": "context.time",
        "operator": "within_hours",
        "value": {
            "start": "09:00",
            "end": "17:00",
            "timezone": "Invalid/Timezone",
        },
    }

    matched = evaluate_condition(
        condition,
        context={},
        now=datetime(2025, 1, 6, 12, 0, tzinfo=timezone.utc),
    )

    assert matched is False
