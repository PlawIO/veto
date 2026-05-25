"""Prompt builder for kernel/custom model validation."""

from __future__ import annotations

from typing import Any, Mapping

from veto.kernel.types import KernelToolCall

SYSTEM_PROMPT = """You are a security guardrail for AI agent tool calls. You receive a tool call and a ruleset defining security policies.
Evaluate whether the tool call violates any rules in the ruleset.
Respond with JSON only:
{"pass_weight": <float 0-1>, "block_weight": <float 0-1>, "decision": "<pass|block>", "reasoning": "<brief explanation>"}"""


def build_system_prompt() -> str:
    return SYSTEM_PROMPT


def _format_value(value: Any, indent: int = 0) -> str:
    spaces = "  " * indent
    if value is None:
        return "null"
    if isinstance(value, str):
        return f'"{value}"'
    if isinstance(value, (int, float, bool)):
        return str(value).lower() if isinstance(value, bool) else str(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(isinstance(item, (str, int, float)) for item in value):
            return "[" + ", ".join(str(item) for item in value) + "]"
        return "".join(f"\n{spaces}- {_format_value(item, indent + 1)}" for item in value)
    if isinstance(value, Mapping):
        if not value:
            return "{}"
        lines = []
        for key, item in value.items():
            formatted = _format_value(item, indent + 1)
            if isinstance(item, Mapping):
                lines.append(f"\n{spaces}{key}:{formatted}")
            else:
                lines.append(f"\n{spaces}{key}: {formatted}")
        return "".join(lines)
    return str(value)


def format_tool_call(tool_call: KernelToolCall | Mapping[str, Any]) -> str:
    tool = tool_call.tool if isinstance(tool_call, KernelToolCall) else tool_call["tool"]
    arguments = (
        tool_call.arguments
        if isinstance(tool_call, KernelToolCall)
        else dict(tool_call.get("arguments", {}))
    )
    lines = ["TOOL CALL:", f"tool: {tool}", "arguments:"]
    for key, value in arguments.items():
        formatted = _format_value(value, 1)
        if isinstance(value, Mapping):
            lines.append(f"  {key}:{formatted}")
        else:
            lines.append(f"  {key}: {formatted}")
    return "\n".join(lines)


def format_rules(rules: list[dict[str, Any]]) -> str:
    lines = ["RULES:"]
    for rule in rules:
        lines.append(f"- id: {rule.get('id')}")
        lines.append(f"  name: {rule.get('name')}")
        lines.append(f"  enabled: {rule.get('enabled')}")
        lines.append(f"  severity: {rule.get('severity')}")
        lines.append(f"  action: {rule.get('action')}")
        tools = rule.get("tools")
        if isinstance(tools, list) and tools:
            lines.append(f"  tools: [{', '.join(str(tool) for tool in tools)}]")
        conditions = rule.get("conditions")
        if isinstance(conditions, list) and conditions:
            lines.append("  conditions:")
            for condition in conditions:
                if not isinstance(condition, Mapping):
                    continue
                lines.append(f"    - field: {condition.get('field')}")
                lines.append(f"      operator: {condition.get('operator')}")
                lines.append(f"      value: {_format_value(condition.get('value'))}")
    return "\n".join(lines)


def build_prompt(
    tool_call: KernelToolCall | Mapping[str, Any],
    rules: list[dict[str, Any]],
) -> str:
    return f"{format_tool_call(tool_call)}\n\n{format_rules(rules)}"

# TypeScript-style aliases.
buildSystemPrompt = build_system_prompt
formatToolCall = format_tool_call
formatRules = format_rules
buildPrompt = build_prompt

