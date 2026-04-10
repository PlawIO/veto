"""
Anthropic SSE interception helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Callable

from veto.proxy.sse import encode_json_sse_event


@dataclass(slots=True)
class AnthropicPendingToolUse:
    index: int
    id: str
    name: str
    input_raw: str


@dataclass(slots=True)
class AnthropicSSEBlockResult:
    line: str
    event_type: str | None = None
    data: dict[str, Any] | None = None
    has_tool_use: bool = False
    tool_use_stop: bool = False
    message_stop: bool = False


def parse_anthropic_sse_lines(lines: list[str]) -> AnthropicSSEBlockResult:
    event_type: str | None = None
    data_str: str | None = None
    raw = "\n".join(lines)

    for line in lines:
        if line.startswith("event: "):
            event_type = line[7:].strip()
        elif line.startswith("data: "):
            data_str = line[6:]

    if data_str is None:
        return AnthropicSSEBlockResult(line=raw, event_type=event_type)

    try:
        data = json.loads(data_str)
    except json.JSONDecodeError:
        return AnthropicSSEBlockResult(line=raw, event_type=event_type)

    if not isinstance(data, dict):
        return AnthropicSSEBlockResult(line=raw, event_type=event_type)

    has_tool_use = False
    tool_use_stop = False
    message_stop = event_type == "message_stop"

    if event_type == "content_block_start":
        block = data.get("content_block")
        if isinstance(block, dict) and block.get("type") == "tool_use":
            has_tool_use = True
    elif event_type == "content_block_delta":
        delta = data.get("delta")
        if isinstance(delta, dict) and delta.get("type") == "input_json_delta":
            has_tool_use = True
    elif event_type == "content_block_stop":
        tool_use_stop = True

    return AnthropicSSEBlockResult(
        line=raw,
        event_type=event_type,
        data=data,
        has_tool_use=has_tool_use,
        tool_use_stop=tool_use_stop,
        message_stop=message_stop,
    )


def merge_anthropic_tool_use_delta(
    pending: dict[int, AnthropicPendingToolUse],
    data: dict[str, Any],
    event_type: str,
) -> None:
    index = data.get("index")
    idx = index if isinstance(index, int) else 0

    if event_type == "content_block_start":
        block = data.get("content_block")
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            return
        pending[idx] = AnthropicPendingToolUse(
            index=idx,
            id=block.get("id") if isinstance(block.get("id"), str) else "",
            name=block.get("name") if isinstance(block.get("name"), str) else "",
            input_raw="",
        )
    elif event_type == "content_block_delta":
        delta = data.get("delta")
        if not isinstance(delta, dict) or delta.get("type") != "input_json_delta":
            return
        existing = pending.get(idx)
        if existing is not None and isinstance(delta.get("partial_json"), str):
            existing.input_raw += delta["partial_json"]


def finalize_anthropic_tool_use(
    tool_use: AnthropicPendingToolUse,
    warn: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    arguments: dict[str, Any] = {}
    try:
        parsed = json.loads(tool_use.input_raw)
        if isinstance(parsed, dict):
            arguments = parsed
    except json.JSONDecodeError:
        if warn is not None:
            warn(
                f"[veto intercept] Malformed tool input for '{tool_use.name}', validating with empty args"
            )

    return {"name": tool_use.name, "id": tool_use.id, "arguments": arguments}


def synth_anthropic_blocked_event(reason: str) -> str:
    return "".join(
        [
            encode_json_sse_event(
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
                event="content_block_start",
            ),
            encode_json_sse_event(
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": f"[BLOCKED by veto] {reason}"},
                },
                event="content_block_delta",
            ),
            encode_json_sse_event(
                {"type": "content_block_stop", "index": 0},
                event="content_block_stop",
            ),
            encode_json_sse_event({}, event="message_stop"),
        ]
    )
