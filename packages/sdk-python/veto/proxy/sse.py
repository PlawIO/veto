"""
SSE framing helpers for the Veto proxy server.
"""

from __future__ import annotations

from typing import Any

from sse_starlette import JSONServerSentEvent, ServerSentEvent


def encode_sse_json(data: dict[str, Any], event: str | None = None) -> str:
    return JSONServerSentEvent(data=data, event=event).encode().decode("utf-8")


def encode_sse_data(data: str, event: str | None = None) -> str:
    return ServerSentEvent(data=data, event=event).encode().decode("utf-8")


def encode_sse_done() -> str:
    return encode_sse_data("[DONE]")
