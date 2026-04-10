"""SSE framing helpers for the Python proxy.

`sse-starlette` is ASGI-first and does not directly own `aiohttp` socket lifecycles.
The proxy still uses `aiohttp` for HTTP transport, but uses `sse-starlette`
`ServerSentEvent` objects for standards-compliant synthetic SSE framing.
"""

from __future__ import annotations

from typing import Optional

from sse_starlette.event import ServerSentEvent


def encode_sse_event(data: str, *, event: Optional[str] = None) -> str:
    encoded = ServerSentEvent(data=data, event=event).encode()
    if isinstance(encoded, bytes):
        return encoded.decode("utf-8")
    return encoded


def encode_comment(comment: str) -> str:
    encoded = ServerSentEvent(comment=comment).encode()
    if isinstance(encoded, bytes):
        return encoded.decode("utf-8")
    return encoded
