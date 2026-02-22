from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable, Mapping
from typing import Any, Literal, Optional
import copy
import re

from veto.utils.logger import Logger
from veto.rules.condition_evaluator import (
    create_safe_regex,
    evaluate_condition_collections,
)

DEFAULT_REDACT_WITH = "[REDACTED]"


@dataclass
class OutputValidationResult:
    decision: Literal["allow", "block"]
    output: Any
    reason: Optional[str] = None
    matched_rule_ids: list[str] | None = None
    redactions: int = 0


@dataclass
class OutputValidatorOptions:
    logger: Logger
    get_rules_for_tool: Callable[[str], list[dict[str, Any]]]


class OutputValidator:
    def __init__(self, options: OutputValidatorOptions):
        self._logger = options.logger
        self._get_rules_for_tool = options.get_rules_for_tool

    def validate(self, tool_name: str, output: Any) -> OutputValidationResult:
        rules = self._get_rules_for_tool(tool_name)
        if not rules:
            return OutputValidationResult(
                decision="allow",
                output=output,
                matched_rule_ids=[],
                redactions=0,
            )

        context = self._build_evaluation_context(tool_name, output)
        matched_rules = [
            rule
            for rule in rules
            if self._matches_rule(rule=rule, context=context)
        ]

        if not matched_rules:
            return OutputValidationResult(
                decision="allow",
                output=output,
                matched_rule_ids=[],
                redactions=0,
            )

        matched_rule_ids = [
            str(rule.get("id"))
            for rule in matched_rules
            if isinstance(rule.get("id"), str)
        ]

        block_rule = next(
            (rule for rule in matched_rules if rule.get("action") == "block"),
            None,
        )
        if block_rule is not None:
            reason_raw = block_rule.get("description")
            reason = (
                reason_raw
                if isinstance(reason_raw, str)
                else f"Output blocked by rule: {block_rule.get('name', 'Unnamed rule')}"
            )
            self._logger.warn(
                "Tool output blocked by output rule",
                {
                    "tool": tool_name,
                    "rule_id": block_rule.get("id"),
                    "reason": reason,
                },
            )
            return OutputValidationResult(
                decision="block",
                output=None,
                reason=reason,
                matched_rule_ids=matched_rule_ids,
                redactions=0,
            )

        transformed_output = output
        redactions = 0

        for rule in matched_rules:
            action = rule.get("action")
            if action == "log":
                self._logger.warn(
                    "Tool output matched log-only output rule",
                    {
                        "tool": tool_name,
                        "rule_id": rule.get("id"),
                        "rule_name": rule.get("name"),
                    },
                )
                continue

            if action == "redact":
                result = self._apply_redaction(rule=rule, output=transformed_output)
                transformed_output = result.output
                redactions += result.redactions

                if result.redactions > 0:
                    self._logger.info(
                        "Tool output redacted by output rule",
                        {
                            "tool": tool_name,
                            "rule_id": rule.get("id"),
                            "redactions": result.redactions,
                        },
                    )

        return OutputValidationResult(
            decision="allow",
            output=transformed_output,
            matched_rule_ids=matched_rule_ids,
            redactions=redactions,
        )

    def _matches_rule(
        self,
        rule: Mapping[str, Any],
        context: Mapping[str, Any],
    ) -> bool:
        conditions_raw = rule.get("output_conditions")
        condition_groups_raw = rule.get("output_condition_groups")

        conditions: Optional[list[Mapping[str, Any]]] = None
        if isinstance(conditions_raw, list):
            conditions = [
                item for item in conditions_raw if isinstance(item, Mapping)
            ]

        condition_groups: Optional[list[list[Mapping[str, Any]]]] = None
        if isinstance(condition_groups_raw, list):
            parsed_groups: list[list[Mapping[str, Any]]] = []
            for group in condition_groups_raw:
                if not isinstance(group, list):
                    continue
                parsed_group = [
                    item for item in group if isinstance(item, Mapping)
                ]
                parsed_groups.append(parsed_group)
            condition_groups = parsed_groups

        return evaluate_condition_collections(
            conditions=conditions,
            condition_groups=condition_groups,
            context=context,
        )

    def _build_evaluation_context(
        self,
        tool_name: str,
        output: Any,
    ) -> dict[str, Any]:
        base: dict[str, Any] = {
            "output": output,
            "tool_name": tool_name,
            "toolName": tool_name,
        }

        if isinstance(output, dict):
            context = dict(output)
            context.update(base)
            return context

        return base

    def _apply_redaction(
        self,
        rule: Mapping[str, Any],
        output: Any,
    ) -> OutputValidationResult:
        redact_with_raw = rule.get("redact_with")
        redact_with = (
            redact_with_raw
            if isinstance(redact_with_raw, str)
            else DEFAULT_REDACT_WITH
        )

        candidate_conditions = self._collect_redaction_conditions(rule)
        if not candidate_conditions:
            return OutputValidationResult(
                decision="allow",
                output=output,
                matched_rule_ids=[],
                redactions=0,
            )

        mutable_output = output
        has_cloned = False
        total_redactions = 0

        def ensure_clone() -> Any:
            nonlocal mutable_output, has_cloned
            if not has_cloned:
                try:
                    mutable_output = copy.deepcopy(output)
                except Exception:
                    mutable_output = output
                has_cloned = True
            return mutable_output

        for condition in candidate_conditions:
            field_raw = condition.get("field")
            pattern_raw = condition.get("value")
            if not isinstance(field_raw, str) or not isinstance(pattern_raw, str):
                continue

            path = self._to_output_path(field_raw)
            if path is None:
                continue

            regex = create_safe_regex(pattern_raw)
            if regex is None:
                self._logger.warn(
                    "Skipping unsafe output redaction regex pattern",
                    {
                        "rule_id": rule.get("id"),
                        "pattern": pattern_raw,
                    },
                )
                continue

            cloned_output = ensure_clone()
            redaction_result = self._redact_at_path(
                output=cloned_output,
                path=path,
                regex=regex,
                replacement=redact_with,
            )
            mutable_output = redaction_result.output
            total_redactions += redaction_result.redactions

        if not has_cloned:
            return OutputValidationResult(
                decision="allow",
                output=output,
                matched_rule_ids=[],
                redactions=0,
            )

        return OutputValidationResult(
            decision="allow",
            output=mutable_output,
            matched_rule_ids=[],
            redactions=total_redactions,
        )

    def _collect_redaction_conditions(
        self,
        rule: Mapping[str, Any],
    ) -> list[Mapping[str, Any]]:
        result: list[Mapping[str, Any]] = []

        direct_conditions = rule.get("output_conditions")
        if isinstance(direct_conditions, list):
            for condition in direct_conditions:
                if (
                    isinstance(condition, Mapping)
                    and condition.get("operator") == "matches"
                ):
                    result.append(condition)

        condition_groups = rule.get("output_condition_groups")
        if isinstance(condition_groups, list):
            for group in condition_groups:
                if not isinstance(group, list):
                    continue
                for condition in group:
                    if (
                        isinstance(condition, Mapping)
                        and condition.get("operator") == "matches"
                    ):
                        result.append(condition)

        return result

    def _to_output_path(self, field: str) -> Optional[str]:
        if field == "output":
            return ""
        if field.startswith("output."):
            return field[len("output.") :]
        if field in {"tool_name", "toolName"}:
            return None
        return field

    def _redact_at_path(
        self,
        output: Any,
        path: str,
        regex: re.Pattern[str],
        replacement: str,
    ) -> OutputValidationResult:
        if path == "":
            if not isinstance(output, str):
                return OutputValidationResult(
                    decision="allow",
                    output=output,
                    matched_rule_ids=[],
                    redactions=0,
                )

            redactions = 0

            def _replace(_: re.Match[str]) -> str:
                nonlocal redactions
                redactions += 1
                return replacement

            redacted = regex.sub(_replace, output)
            return OutputValidationResult(
                decision="allow",
                output=redacted,
                matched_rule_ids=[],
                redactions=redactions,
            )

        parent_key = self._resolve_mutable_parent(output, path)
        if parent_key is None:
            return OutputValidationResult(
                decision="allow",
                output=output,
                matched_rule_ids=[],
                redactions=0,
            )

        parent, key = parent_key
        current = parent.get(key)
        if not isinstance(current, str):
            return OutputValidationResult(
                decision="allow",
                output=output,
                matched_rule_ids=[],
                redactions=0,
            )

        redactions = 0

        def _replace_nested(_: re.Match[str]) -> str:
            nonlocal redactions
            redactions += 1
            return replacement

        parent[key] = regex.sub(_replace_nested, current)
        return OutputValidationResult(
            decision="allow",
            output=output,
            matched_rule_ids=[],
            redactions=redactions,
        )

    def _resolve_mutable_parent(
        self,
        root: Any,
        path: str,
    ) -> Optional[tuple[dict[str, Any], str]]:
        if not isinstance(root, dict):
            return None

        parts = path.split(".")
        if not parts:
            return None

        current: Any = root
        for segment in parts[:-1]:
            if not isinstance(current, dict):
                return None
            current = current.get(segment)

        if not isinstance(current, dict):
            return None

        return current, parts[-1]
