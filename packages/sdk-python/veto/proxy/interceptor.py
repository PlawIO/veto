"""Helpers for intercepting OpenAI-style SSE tool calls."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class PendingToolCall:
    index: int
    id: str
    name: str
    arguments_raw: str


@dataclass
class SSELineResult:
    line: str
    data: Optional[dict[str, Any]] = None
    done: bool = False
    has_tool_calls: bool = False
    finish_reason_tool_calls: bool = False


def parse_sse_line(line: str) -> SSELineResult:
    if line == "data: [DONE]":
        return SSELineResult(line=line, done=True)
    if not line.startswith("data: "):
        return SSELineResult(line=line)

    json_str = line[6:]
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        return SSELineResult(line=line)

    if not isinstance(data, dict):
        return SSELineResult(line=line)

    choices = data.get("choices")
    has_tool_calls = False
    finish_reason_tool_calls = False
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            if choice.get("finish_reason") == "tool_calls":
                finish_reason_tool_calls = True
            delta = choice.get("delta")
            if isinstance(delta, dict):
                tool_calls = delta.get("tool_calls")
                if isinstance(tool_calls, list) and tool_calls:
                    has_tool_calls = True

    return SSELineResult(
        line=line,
        data=data,
        has_tool_calls=has_tool_calls,
        finish_reason_tool_calls=finish_reason_tool_calls,
    )


def merge_tool_call_deltas(
    pending: dict[int, PendingToolCall],
    data: dict[str, Any],
) -> None:
    choices = data.get("choices")
    if not isinstance(choices, list):
        return

    for choice in choices:
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        tool_calls = delta.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue

        for item in tool_calls:
            if not isinstance(item, dict):
                continue
            index = item.get("index") if isinstance(item.get("index"), int) else 0
            if index not in pending:
                function = item.get("function")
                name = ""
                if isinstance(function, dict) and isinstance(function.get("name"), str):
                    name = function["name"]
                tool_id = item.get("id") if isinstance(item.get("id"), str) else ""
                pending[index] = PendingToolCall(
                    index=index,
                    id=tool_id,
                    name=name,
                    arguments_raw="",
                )

            current = pending[index]
            function = item.get("function")
            if isinstance(function, dict):
                name = function.get("name")
                if isinstance(name, str) and name and not current.name:
                    current.name = name
                arguments = function.get("arguments")
                if isinstance(arguments, str):
                    current.arguments_raw += arguments


def finalize_tool_call(tc: PendingToolCall) -> dict[str, Any]:
    args: dict[str, Any] = {}
    try:
        parsed = json.loads(tc.arguments_raw)
        if isinstance(parsed, dict):
            args = parsed
    except json.JSONDecodeError:
        print(f"[veto proxy] malformed tool arguments for '{tc.name}', validating with empty args")
    return {"name": tc.name, "id": tc.id, "arguments": args}


def synth_blocked_event(reason: str, request_id: Optional[str] = None) -> str:
    chunk = {
        "id": request_id or "veto-blocked",
        "object": "chat.completion.chunk",
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": f"[BLOCKED by veto] {reason}"},
                "finish_reason": "stop",
            }
        ],
    }
    return f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n"
