"""Helpers for intercepting Anthropic-style SSE tool calls."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class AnthropicPendingToolUse:
    index: int
    id: str
    name: str
    input_raw: str


@dataclass
class AnthropicSSELineResult:
    line: str
    event_type: Optional[str] = None
    data: Optional[dict[str, Any]] = None
    has_tool_use: bool = False
    tool_use_stop: bool = False
    message_stop: bool = False


def parse_anthropic_sse_lines(lines: list[str]) -> AnthropicSSELineResult:
    event_type: Optional[str] = None
    data_str: Optional[str] = None
    raw = "\n".join(lines)

    for line in lines:
        if line.startswith("event: "):
            event_type = line[7:].strip()
        elif line.startswith("data: "):
            data_str = line[6:]

    if data_str is None:
        return AnthropicSSELineResult(line=raw, event_type=event_type)

    try:
        parsed = json.loads(data_str)
    except json.JSONDecodeError:
        return AnthropicSSELineResult(line=raw, event_type=event_type)

    if not isinstance(parsed, dict):
        return AnthropicSSELineResult(line=raw, event_type=event_type)

    has_tool_use = False
    tool_use_stop = False
    message_stop = event_type == "message_stop"

    if event_type == "content_block_start":
        block = parsed.get("content_block")
        if isinstance(block, dict) and block.get("type") == "tool_use":
            has_tool_use = True
    elif event_type == "content_block_delta":
        delta = parsed.get("delta")
        if isinstance(delta, dict) and delta.get("type") == "input_json_delta":
            has_tool_use = True
    elif event_type == "content_block_stop":
        tool_use_stop = True

    return AnthropicSSELineResult(
        line=raw,
        event_type=event_type,
        data=parsed,
        has_tool_use=has_tool_use,
        tool_use_stop=tool_use_stop,
        message_stop=message_stop,
    )


def merge_anthropic_tool_use_delta(
    pending: dict[int, AnthropicPendingToolUse],
    data: dict[str, Any],
    event_type: str,
) -> None:
    index = data.get("index") if isinstance(data.get("index"), int) else 0

    if event_type == "content_block_start":
        block = data.get("content_block")
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            return
        pending[index] = AnthropicPendingToolUse(
            index=index,
            id=block.get("id") if isinstance(block.get("id"), str) else "",
            name=block.get("name") if isinstance(block.get("name"), str) else "",
            input_raw="",
        )
    elif event_type == "content_block_delta":
        delta = data.get("delta")
        if not isinstance(delta, dict) or delta.get("type") != "input_json_delta":
            return
        current = pending.get(index)
        if current and isinstance(delta.get("partial_json"), str):
            current.input_raw += delta["partial_json"]


def finalize_anthropic_tool_use(tc: AnthropicPendingToolUse) -> dict[str, Any]:
    args: dict[str, Any] = {}
    try:
        parsed = json.loads(tc.input_raw)
        if isinstance(parsed, dict):
            args = parsed
    except json.JSONDecodeError:
        print(f"[veto proxy] malformed tool input for '{tc.name}', validating with empty args")
    return {"name": tc.name, "id": tc.id, "arguments": args}


def synth_anthropic_blocked_event(reason: str) -> str:
    block_start = {
        "type": "content_block_start",
        "index": 0,
        "content_block": {"type": "text", "text": ""},
    }
    block_delta = {
        "type": "content_block_delta",
        "index": 0,
        "delta": {"type": "text_delta", "text": f"[BLOCKED by veto] {reason}"},
    }
    block_stop = {"type": "content_block_stop", "index": 0}
    return "".join(
        f"event: {event}\ndata: {json.dumps(payload)}\n\n"
        for event, payload in [
            ("content_block_start", block_start),
            ("content_block_delta", block_delta),
            ("content_block_stop", block_stop),
            ("message_stop", {}),
        ]
    )
