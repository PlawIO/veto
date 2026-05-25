"""Pipeline DSL helpers.

Python parity for ``veto-sdk/rules/pipeline-dsl``. The platform executes
pipelines; the SDK validates specs and computes stable content-hash ids.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from typing import Any

IDENTIFIER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
RESOLVER_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

LEAF_STEP_KINDS = {"search", "fetch", "extract", "aggregate", "diff"}
STEP_KINDS = {*LEAF_STEP_KINDS, "foreach"}
AGGREGATE_OPS = {"unique", "count", "union", "intersect"}
DIFF_EMITS = {"added", "removed", "changed"}
OUTPUT_SHAPES = {"list_of_strings", "list_of_objects"}
ON_FAILURE = {"skip", "fail_open", "fail_closed", "last_known_good"}

PipelineSpec = dict[str, Any]
PipelineStep = dict[str, Any]
PipelineSchedule = dict[str, Any]
PipelineOutput = dict[str, Any]
PipelineBudget = dict[str, Any]


def _plain_json(value: Any, path: str = "$") -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError(f"canonicalize_json: non-finite number at {path}")
        return value
    if isinstance(value, list):
        return [_plain_json(item, f"{path}[]") for item in value]
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"canonicalize_json: non-string key at {path}")
            normalized[key] = _plain_json(item, f"{path}.{key}")
        return normalized
    raise TypeError(
        "canonicalize_json: unsupported non-JSON value "
        f"{type(value).__name__} at {path}"
    )


def canonicalize_json(value: Any) -> str:
    """Canonicalize a JSON value for content-addressable hashing."""
    return json.dumps(
        _plain_json(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def compute_pipeline_id(spec: PipelineSpec) -> str:
    """Compute the sha256 content id of a pipeline spec minus its ``id``."""
    spec_without_id = deepcopy(spec)
    spec_without_id.pop("id", None)
    canonical = canonicalize_json(spec_without_id)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_string(value: Any, label: str, *, min_len: int, max_len: int) -> str:
    if not isinstance(value, str) or not (min_len <= len(value) <= max_len):
        raise ValueError(f"{label} must be a string length {min_len}..{max_len}")
    return value


def _require_int(value: Any, label: str, *, min_value: int, max_value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{label} must be an integer")
    if value < min_value or value > max_value:
        raise ValueError(f"{label} must be between {min_value} and {max_value}")
    return value


def _validate_identifier(value: Any, label: str) -> str:
    raw = _require_string(value, label, min_len=1, max_len=64)
    if IDENTIFIER_RE.fullmatch(raw) is None:
        raise ValueError(
            f"{label} must start with a letter and contain only [A-Za-z0-9_]"
        )
    return raw


def _validate_resolver(value: Any, label: str) -> str:
    raw = _require_string(value, label, min_len=1, max_len=64)
    if RESOLVER_RE.fullmatch(raw) is None:
        raise ValueError(f"{label} must be lowercase kebab/snake")
    return raw


def _validate_optional_as(step: dict[str, Any], label: str) -> None:
    if "as" in step:
        _validate_identifier(step["as"], f"{label}.as")


def _validate_leaf_step(step: dict[str, Any], label: str) -> None:
    kind = step.get("kind")
    if kind == "search":
        _validate_resolver(step.get("resolver"), f"{label}.resolver")
        _require_string(step.get("query"), f"{label}.query", min_len=1, max_len=2048)
        if "limit" in step:
            _require_int(step["limit"], f"{label}.limit", min_value=1, max_value=1000)
        _validate_optional_as(step, label)
        return
    if kind == "fetch":
        _validate_resolver(step.get("resolver"), f"{label}.resolver")
        _require_string(step.get("id_from"), f"{label}.id_from", min_len=1, max_len=256)
        fields = step.get("fields")
        if not isinstance(fields, list) or not (1 <= len(fields) <= 32):
            raise ValueError(f"{label}.fields must contain 1..32 strings")
        for index, field in enumerate(fields):
            _require_string(field, f"{label}.fields[{index}]", min_len=1, max_len=128)
        _validate_optional_as(step, label)
        return
    if kind == "extract":
        _require_string(step.get("from"), f"{label}.from", min_len=1, max_len=256)
        _require_string(step.get("selector"), f"{label}.selector", min_len=1, max_len=256)
        _validate_identifier(step.get("as"), f"{label}.as")
        return
    if kind == "aggregate":
        _require_string(step.get("source"), f"{label}.source", min_len=1, max_len=256)
        if step.get("op") not in AGGREGATE_OPS:
            raise ValueError(f"{label}.op must be one of {sorted(AGGREGATE_OPS)}")
        _validate_optional_as(step, label)
        return
    if kind == "diff":
        _require_string(step.get("current"), f"{label}.current", min_len=1, max_len=256)
        _require_string(step.get("previous"), f"{label}.previous", min_len=1, max_len=256)
        if step.get("emit") not in DIFF_EMITS:
            raise ValueError(f"{label}.emit must be one of {sorted(DIFF_EMITS)}")
        _validate_optional_as(step, label)
        return
    raise ValueError(f"{label}.kind must be one of {sorted(LEAF_STEP_KINDS)}")


def _validate_step(step_raw: Any, label: str) -> None:
    step = _require_mapping(step_raw, label)
    kind = step.get("kind")
    if kind not in STEP_KINDS:
        raise ValueError(f"{label}.kind must be one of {sorted(STEP_KINDS)}")

    if kind == "foreach":
        _require_string(step.get("source"), f"{label}.source", min_len=1, max_len=256)
        nested = step.get("do")
        if not isinstance(nested, list) or not (1 <= len(nested) <= 16):
            raise ValueError(f"{label}.do must contain 1..16 leaf steps")
        for index, nested_step in enumerate(nested):
            nested_map = _require_mapping(nested_step, f"{label}.do[{index}]")
            if nested_map.get("kind") == "foreach":
                raise ValueError(f"{label}.do[{index}] cannot be nested foreach")
            _validate_leaf_step(nested_map, f"{label}.do[{index}]")
        _validate_optional_as(step, label)
        return

    _validate_leaf_step(step, label)


def _validate_schedule(schedule_raw: Any) -> None:
    schedule = _require_mapping(schedule_raw, "schedule")
    kind = schedule.get("kind")
    if kind == "interval":
        _require_int(
            schedule.get("every_sec"),
            "schedule.every_sec",
            min_value=60,
            max_value=7 * 24 * 60 * 60,
        )
        return
    if kind == "cron":
        _require_string(schedule.get("expr"), "schedule.expr", min_len=1, max_len=128)
        return
    raise ValueError('schedule.kind must be "interval" or "cron"')


def _validate_pipeline_spec(spec: dict[str, Any]) -> None:
    if spec.get("dsl_version") != 1:
        raise ValueError("dsl_version must be 1")

    pipeline_id = spec.get("id")
    if not isinstance(pipeline_id, str) or SHA256_RE.fullmatch(pipeline_id) is None:
        raise ValueError("id must be a 64-character lowercase hex sha256")

    if "description" in spec:
        _require_string(spec["description"], "description", min_len=0, max_len=512)

    _validate_schedule(spec.get("schedule"))

    steps = spec.get("steps")
    if not isinstance(steps, list) or not (1 <= len(steps) <= 32):
        raise ValueError("steps must contain 1..32 steps")
    for index, step in enumerate(steps):
        _validate_step(step, f"steps[{index}]")

    output = _require_mapping(spec.get("output"), "output")
    if output.get("shape") not in OUTPUT_SHAPES:
        raise ValueError(f"output.shape must be one of {sorted(OUTPUT_SHAPES)}")

    budget = _require_mapping(spec.get("budget"), "budget")
    _require_int(
        budget.get("max_resolver_calls_per_run"),
        "budget.max_resolver_calls_per_run",
        min_value=1,
        max_value=10_000,
    )
    _require_int(
        budget.get("max_tokens_per_run"),
        "budget.max_tokens_per_run",
        min_value=0,
        max_value=1_000_000,
    )

    if spec.get("on_failure") not in ON_FAILURE:
        raise ValueError(f"on_failure must be one of {sorted(ON_FAILURE)}")


def parse_pipeline_spec(input_value: Any) -> PipelineSpec:
    """Parse and validate an untrusted pipeline spec."""
    spec = _require_mapping(input_value, "pipeline")
    parsed = deepcopy(spec)
    _validate_pipeline_spec(parsed)
    return parsed


def verify_pipeline_id(spec: PipelineSpec) -> bool:
    """Return True when ``spec.id`` matches the content hash."""
    return spec.get("id") == compute_pipeline_id(spec)


def stamp_pipeline_id(draft: PipelineSpec) -> PipelineSpec:
    """Return a copy of ``draft`` with the correct content-hash id."""
    stamped = deepcopy(draft)
    stamped["id"] = compute_pipeline_id(stamped)
    return parse_pipeline_spec(stamped)


__all__ = [
    "PipelineBudget",
    "PipelineOutput",
    "PipelineSchedule",
    "PipelineSpec",
    "PipelineStep",
    "canonicalize_json",
    "compute_pipeline_id",
    "parse_pipeline_spec",
    "stamp_pipeline_id",
    "verify_pipeline_id",
]

