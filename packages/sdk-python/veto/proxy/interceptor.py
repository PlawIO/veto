"""
OpenAI SSE interception helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable

from veto.proxy.sse import encode_sse_done, encode_sse_json


@dataclass(slots=True)
class PendingToolCall:
    index: int
    id: str
    name: str
    arguments_raw: str


@dataclass(slots=True)
class SSELineResult:
    line: str
    data: dict[str, Any] | None = None
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
            if not isinstance(delta, dict):
                continue
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

        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            index = tool_call.get("index")
            idx = index if isinstance(index, int) else 0
            if idx not in pending:
                fn = tool_call.get("function")
                name = ""
                if isinstance(fn, dict) and isinstance(fn.get("name"), str):
                    name = fn["name"]
                pending[idx] = PendingToolCall(
                    index=idx,
                    id=tool_call.get("id") if isinstance(tool_call.get("id"), str) else "",
                    name=name,
                    arguments_raw="",
                )

            existing = pending[idx]
            fn = tool_call.get("function")
            if isinstance(fn, dict):
                if isinstance(fn.get("name"), str) and fn["name"] and not existing.name:
                    existing.name = fn["name"]
                if isinstance(fn.get("arguments"), str):
                    existing.arguments_raw += fn["arguments"]


def finalize_tool_call(
    tool_call: PendingToolCall,
    warn: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    arguments: dict[str, Any] = {}
    try:
        parsed = json.loads(tool_call.arguments_raw)
        if isinstance(parsed, dict):
            arguments = parsed
    except json.JSONDecodeError:
        if warn is not None:
            warn(
                f"[veto intercept] Malformed tool arguments for '{tool_call.name}', validating with empty args"
            )

    return {"name": tool_call.name, "id": tool_call.id, "arguments": arguments}


def synth_blocked_event(reason: str, request_id: str | None = None) -> str:
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
    return encode_sse_json(chunk) + encode_sse_done()
