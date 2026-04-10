"""
SSE framing helpers for the Veto proxy server.
"""

from __future__ import annotations

import json
from typing import Any

from sse_starlette import ServerSentEvent


def encode_sse_event(
    data: str,
    *,
    event: str | None = None,
    event_id: str | None = None,
    retry: int | None = None,
    comment: str | None = None,
) -> str:
    return ServerSentEvent(
        data=data,
        event=event,
        id=event_id,
        retry=retry,
        comment=comment,
    ).encode().decode("utf-8")


def encode_json_sse_event(
    data: dict[str, Any],
    *,
    event: str | None = None,
    event_id: str | None = None,
) -> str:
    return encode_sse_event(
        json.dumps(data, separators=(",", ":")),
        event=event,
        event_id=event_id,
    )


def encode_sse_done() -> str:
    return encode_sse_event("[DONE]")
