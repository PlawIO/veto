"""
Integration and helper tests for the Python proxy server.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

import aiohttp
import pytest
from aiohttp import ClientConnectorError, web

import veto
import veto.proxy as veto_proxy
from veto import GuardResult
from veto.core.veto import Veto
from veto.proxy import ProxyConfig, ProxyServer, start_proxy_server
from veto.proxy.anthropic_interceptor import (
    AnthropicPendingToolUse,
    finalize_anthropic_tool_use,
    merge_anthropic_tool_use_delta,
    parse_anthropic_sse_lines,
    synth_anthropic_blocked_event,
)
from veto.proxy.interceptor import (
    PendingToolCall,
    finalize_tool_call,
    merge_tool_call_deltas,
    parse_sse_line,
    synth_blocked_event,
)
from veto.proxy.sse import encode_sse_event


@pytest.fixture
def veto_config_dir(tmp_path: Path) -> str:
    config_dir = tmp_path / "veto"
    rules_dir = config_dir / "rules"
    rules_dir.mkdir(parents=True, exist_ok=True)

    (config_dir / "veto.config.yaml").write_text(
        "\n".join(
            [
                'version: "1.0"',
                'mode: "strict"',
                'validation:',
                '  mode: "local"',
                'logging:',
                '  level: "silent"',
                'rules:',
                '  directory: "./rules"',
            ]
        ),
        encoding="utf-8",
    )
    (rules_dir / "rules.yaml").write_text(
        "\n".join(
            [
                'version: "1.0"',
                'name: test',
                'rules:',
                '  - id: block-delete',
                '    name: Block delete',
                '    enabled: true',
                '    severity: high',
                '    action: block',
                '    tools: [delete_file]',
            ]
        ),
        encoding="utf-8",
    )
    return str(config_dir)


async def _start_server(
    handler: Callable[[web.Request], Awaitable[web.StreamResponse | web.Response]],
) -> tuple[str, Callable[[], Awaitable[None]]]:
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    server = site._server
    assert server is not None
    sockets = server.sockets
    assert sockets is not None
    port = int(sockets[0].getsockname()[1])

    async def stop() -> None:
        await runner.cleanup()

    return f"http://127.0.0.1:{port}", stop


async def _request_text(
    proxy_port: int,
    path: str,
    body: dict[str, Any],
    headers: dict[str, str] | None = None,
) -> tuple[int, str, dict[str, str]]:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"http://127.0.0.1:{proxy_port}{path}",
            json=body,
            headers=headers,
        ) as response:
            return response.status, await response.text(), dict(response.headers)


async def _start_proxy(
    veto_config_dir: str,
    upstream_url: str,
    *,
    fmt: str,
    max_buffer_bytes: int = 1024 * 1024,
) -> ProxyServer:
    return await start_proxy_server(
        ProxyConfig(
            port=0,
            target=upstream_url,
            max_buffer_bytes=max_buffer_bytes,
            config_dir=veto_config_dir,
            format=fmt,
        )
    )


def _build_openai_tool_call_sse(tool_name: str, args: str) -> str:
    delta1 = json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "tc_1",
                                "function": {"name": tool_name, "arguments": ""},
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        },
        separators=(",", ":"),
    )
    delta2 = json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "function": {"arguments": args}}
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        },
        separators=(",", ":"),
    )
    finish = json.dumps(
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
        separators=(",", ":"),
    )
    return "".join(
        [
            encode_sse_event(delta1),
            encode_sse_event(delta2),
            encode_sse_event(finish),
            encode_sse_event("[DONE]"),
        ]
    )


def _build_openai_content_sse(text: str) -> str:
    chunk = json.dumps(
        {"choices": [{"delta": {"content": text}, "finish_reason": None}]},
        separators=(",", ":"),
    )
    done = json.dumps(
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        separators=(",", ":"),
    )
    return "".join(
        [
            encode_sse_event(chunk),
            encode_sse_event(done),
            encode_sse_event("[DONE]"),
        ]
    )


def _build_openai_non_stream_tool_call(tool_name: str) -> bytes:
    return json.dumps(
        {
            "id": "chatcmpl-123",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": '{"path":"/etc/hosts"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _build_anthropic_tool_use_sse(tool_name: str, input_json: str) -> str:
    return "".join(
        [
            encode_sse_event(
                json.dumps(
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": tool_name,
                        },
                    },
                    separators=(",", ":"),
                ),
                event="content_block_start",
            ),
            encode_sse_event(
                json.dumps(
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": input_json,
                        },
                    },
                    separators=(",", ":"),
                ),
                event="content_block_delta",
            ),
            encode_sse_event(
                json.dumps(
                    {"type": "content_block_stop", "index": 0},
                    separators=(",", ":"),
                ),
                event="content_block_stop",
            ),
            encode_sse_event("{}", event="message_stop"),
        ]
    )


def _build_anthropic_text_sse(text: str) -> str:
    return "".join(
        [
            encode_sse_event(
                json.dumps(
                    {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {"type": "text", "text": ""},
                    },
                    separators=(",", ":"),
                ),
                event="content_block_start",
            ),
            encode_sse_event(
                json.dumps(
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {"type": "text_delta", "text": text},
                    },
                    separators=(",", ":"),
                ),
                event="content_block_delta",
            ),
            encode_sse_event(
                json.dumps(
                    {"type": "content_block_stop", "index": 0},
                    separators=(",", ":"),
                ),
                event="content_block_stop",
            ),
            encode_sse_event(
                json.dumps(
                    {
                        "type": "message_delta",
                        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                        "usage": {"output_tokens": 1},
                    },
                    separators=(",", ":"),
                ),
                event="message_delta",
            ),
            encode_sse_event("{}", event="message_stop"),
        ]
    )


def _extract_openai_data_lines(payload: str) -> list[str]:
    normalized = payload.replace("\r\n", "\n")
    return [line for line in normalized.splitlines() if line.startswith("data: ")]


def _extract_anthropic_event_lines(payload: str) -> list[list[str]]:
    normalized = payload.replace("\r\n", "\n")
    return [block.splitlines() for block in normalized.strip().split("\n\n") if block.strip()]


def _build_anthropic_non_stream_tool_use(tool_name: str) -> bytes:
    return json.dumps(
        {
            "id": "msg_123",
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": tool_name,
                    "input": {"path": "/etc/hosts"},
                }
            ],
            "stop_reason": "tool_use",
        },
        separators=(",", ":"),
    ).encode("utf-8")


def _gzip_response(body: bytes, content_type: str) -> web.Response:
    return web.Response(
        body=gzip.compress(body),
        headers={
            "Content-Type": content_type,
            "Content-Encoding": "gzip",
        },
    )


def test_veto_proxy_exports_exact_surface() -> None:
    assert veto_proxy.__all__ == ["ProxyConfig", "ProxyServer", "start_proxy_server"]
    assert veto_proxy.ProxyConfig is ProxyConfig
    assert veto_proxy.ProxyServer is ProxyServer
    assert veto_proxy.start_proxy_server is start_proxy_server
    assert veto.ProxyConfig is ProxyConfig
    assert veto.ProxyServer is ProxyServer
    assert veto.start_proxy_server is start_proxy_server


def test_encode_sse_event_and_openai_helpers() -> None:
    encoded = encode_sse_event("hello", event="message", event_id="evt-1")
    assert "event: message" in encoded
    assert "id: evt-1" in encoded
    assert "data: hello" in encoded

    pending: dict[int, PendingToolCall] = {}
    openai_lines = _extract_openai_data_lines(
        _build_openai_tool_call_sse("delete_file", '{"path":"/tmp"}')
    )
    first_line = parse_sse_line(openai_lines[0])
    second_line = parse_sse_line(openai_lines[1])
    finish_line = parse_sse_line(openai_lines[2])
    assert first_line.has_tool_calls is True
    assert second_line.has_tool_calls is True
    assert finish_line.finish_reason_tool_calls is True
    merge_tool_call_deltas(pending, first_line.data or {})
    merge_tool_call_deltas(pending, second_line.data or {})
    merge_tool_call_deltas(pending, finish_line.data or {})
    finalized = finalize_tool_call(pending[0])
    assert finalized == {
        "name": "delete_file",
        "id": "tc_1",
        "arguments": {"path": "/tmp"},
    }

    malformed = finalize_tool_call(PendingToolCall(0, "tc_2", "delete_file", '{"path":'))
    assert malformed["arguments"] == {}

    blocked = synth_blocked_event("Denied", request_id="req_1")
    assert '"id":"req_1"' in blocked
    assert "[BLOCKED by veto] Denied" in blocked
    assert "data: [DONE]" in blocked


def test_anthropic_helpers() -> None:
    pending: dict[int, AnthropicPendingToolUse] = {}
    anthropic_blocks = _extract_anthropic_event_lines(
        _build_anthropic_tool_use_sse("delete_file", '{"path":"/tmp"}')
    )
    start_lines, delta_lines = anthropic_blocks[0], anthropic_blocks[1]
    stop_lines = anthropic_blocks[-1]

    parsed_start = parse_anthropic_sse_lines(start_lines)
    parsed_delta = parse_anthropic_sse_lines(delta_lines)
    parsed_stop = parse_anthropic_sse_lines(stop_lines)
    assert parsed_start.has_tool_use is True
    assert parsed_delta.has_tool_use is True
    assert parsed_stop.message_stop is True

    merge_anthropic_tool_use_delta(pending, parsed_start.data or {}, parsed_start.event_type or "")
    merge_anthropic_tool_use_delta(pending, parsed_delta.data or {}, parsed_delta.event_type or "")
    finalized = finalize_anthropic_tool_use(pending[0])
    assert finalized == {
        "name": "delete_file",
        "id": "toolu_1",
        "arguments": {"path": "/tmp"},
    }

    malformed = finalize_anthropic_tool_use(
        AnthropicPendingToolUse(0, "toolu_2", "delete_file", '{"path":')
    )
    assert malformed["arguments"] == {}

    blocked = synth_anthropic_blocked_event("Denied")
    assert "event: content_block_start" in blocked
    assert "event: message_delta" in blocked
    assert '"stop_reason":"end_turn"' in blocked
    assert "event: message_stop" in blocked
    assert "[BLOCKED by veto] Denied" in blocked


@pytest.mark.asyncio
async def test_openai_sse_blocked(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_openai_tool_call_sse("delete_file", '{"path":"/etc/hosts"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in body
        assert "data: [DONE]" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_openai_sse_allowed(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_openai_tool_call_sse("read_file", '{"path":"/tmp/file"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" not in body
        assert "read_file" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_openai_sse_buffer_overflow_blocks(veto_config_dir: str, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_guard(self: Veto, name: str, arguments: dict[str, Any]) -> GuardResult:
        calls.append((name, arguments))
        return GuardResult(decision="deny", reason="blocked")

    monkeypatch.setattr(Veto, "guard", fake_guard)
    huge_args = json.dumps({"path": "/etc/hosts", "padding": "x" * 4096})

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(_build_openai_tool_call_sse("delete_file", huge_args).encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai", max_buffer_bytes=64)

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in body
        assert calls == []
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_sse_blocked(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_anthropic_tool_use_sse("delete_file", '{"path":"/etc/hosts"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in body
        assert "event: content_block_delta" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_sse_allowed(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_anthropic_tool_use_sse("read_file", '{"path":"/tmp/file"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" not in body
        assert '"name":"read_file"' in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_sse_buffer_overflow_blocks(veto_config_dir: str, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_guard(self: Veto, name: str, arguments: dict[str, Any]) -> GuardResult:
        calls.append((name, arguments))
        return GuardResult(decision="deny", reason="blocked")

    monkeypatch.setattr(Veto, "guard", fake_guard)
    huge_input = json.dumps({"path": "/etc/hosts", "padding": "x" * 4096})

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(_build_anthropic_tool_use_sse("delete_file", huge_input).encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic", max_buffer_bytes=64)

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in body
        assert "event: message_delta" in body
        assert calls == []
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_openai_non_stream_blocked_and_allowed(veto_config_dir: str) -> None:
    responses = [
        _build_openai_non_stream_tool_call("delete_file"),
        _build_openai_non_stream_tool_call("read_file"),
    ]
    index = 0

    async def upstream_handler(_request: web.Request) -> web.Response:
        nonlocal index
        body = responses[index]
        index += 1
        return web.Response(body=body, content_type="application/json")

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        status, blocked_body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": False, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in blocked_body

        status, allowed_body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": False, "messages": []},
        )
        assert status == 200
        parsed = json.loads(allowed_body)
        assert parsed["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "read_file"
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_non_stream_blocked_and_allowed(veto_config_dir: str) -> None:
    responses = [
        _build_anthropic_non_stream_tool_use("delete_file"),
        _build_anthropic_non_stream_tool_use("read_file"),
    ]
    index = 0

    async def upstream_handler(_request: web.Request) -> web.Response:
        nonlocal index
        body = responses[index]
        index += 1
        return web.Response(body=body, content_type="application/json")

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic")

    try:
        status, blocked_body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": False, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in blocked_body

        status, allowed_body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": False, "messages": []},
        )
        assert status == 200
        parsed = json.loads(allowed_body)
        assert parsed["content"][0]["name"] == "read_file"
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_openai_intercept_forces_identity_encoding(veto_config_dir: str) -> None:
    captured: dict[str, str | None] = {}
    body = _build_openai_tool_call_sse("delete_file", '{"path":"/etc/hosts"}').encode("utf-8")

    async def upstream_handler(request: web.Request) -> web.StreamResponse | web.Response:
        accept_encoding = request.headers.get("Accept-Encoding")
        captured["accept_encoding"] = accept_encoding
        if accept_encoding != "identity":
            return _gzip_response(body, "text/event-stream")

        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(body)
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        status, response_body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
            headers={"Accept-Encoding": "gzip"},
        )
        assert status == 200
        assert captured["accept_encoding"] == "identity"
        assert "[BLOCKED by veto]" in response_body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_intercept_forces_identity_encoding(veto_config_dir: str) -> None:
    captured: dict[str, str | None] = {}
    body = _build_anthropic_non_stream_tool_use("delete_file")

    async def upstream_handler(request: web.Request) -> web.Response:
        accept_encoding = request.headers.get("Accept-Encoding")
        captured["accept_encoding"] = accept_encoding
        if accept_encoding != "identity":
            return _gzip_response(body, "application/json")
        return web.Response(body=body, content_type="application/json")

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic")

    try:
        status, response_body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": False, "messages": []},
            headers={"Accept-Encoding": "gzip"},
        )
        assert status == 200
        assert captured["accept_encoding"] == "identity"
        assert "[BLOCKED by veto]" in response_body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_intercept_target_uses_request_path_only(veto_config_dir: str) -> None:
    captured: dict[str, str | None] = {}

    async def upstream_handler(request: web.Request) -> web.StreamResponse:
        captured["accept_encoding"] = request.headers.get("Accept-Encoding")
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(_build_openai_content_sse("query-ok").encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/other?target=/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
            headers={"Accept-Encoding": "gzip"},
        )
        assert status == 200
        assert captured["accept_encoding"] == "gzip"
        assert "query-ok" in body
        assert "[BLOCKED by veto]" not in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_proxy_strips_hop_by_hop_request_headers(veto_config_dir: str) -> None:
    captured: dict[str, str | None] = {}

    async def upstream_handler(request: web.Request) -> web.Response:
        for key in [
            "Connection",
            "Keep-Alive",
            "Transfer-Encoding",
            "Proxy-Authenticate",
            "Proxy-Authorization",
            "TE",
            "Trailer",
            "Trailers",
            "Upgrade",
            "X-Remove-Me",
            "Host",
        ]:
            captured[key] = request.headers.get(key)
        return web.json_response({"ok": True})

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"http://127.0.0.1:{server.port}/headers",
                json={"hello": "world"},
                headers={
                    "Connection": "keep-alive, x-remove-me",
                    "Keep-Alive": "timeout=5",
                    "Proxy-Authenticate": "basic",
                    "Proxy-Authorization": "secret",
                    "TE": "trailers",
                    "Trailer": "Expires",
                    "Trailers": "Expires",
                    "Upgrade": "websocket",
                    "X-Remove-Me": "yes",
                },
            ) as response:
                assert response.status == 200
                assert await response.json() == {"ok": True}

        for key in [
            "Connection",
            "Keep-Alive",
            "Proxy-Authenticate",
            "Proxy-Authorization",
            "TE",
            "Trailer",
            "Trailers",
            "Upgrade",
            "X-Remove-Me",
        ]:
            assert captured[key] is None
        assert captured["Host"] == upstream_url.replace("http://", "")
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_openai_sse_flushes_partial_event_at_eof(veto_config_dir: str) -> None:
    payload = _build_openai_tool_call_sse("read_file", '{"path":"/tmp/file"}')
    payload = payload.removesuffix("\n\n")

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(payload.encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "read_file" in body
        assert "data: [DONE]" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_sse_flushes_partial_event_at_eof(veto_config_dir: str) -> None:
    payload = _build_anthropic_tool_use_sse("read_file", '{"path":"/tmp/file"}')
    payload = payload.removesuffix("\n\n")

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(payload.encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert '"name":"read_file"' in body
        assert "event: message_stop" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_sse_eof_without_message_stop_blocks(veto_config_dir: str) -> None:
    payload = _build_anthropic_tool_use_sse("delete_file", '{"path":"/etc/hosts"}')
    payload = payload.rsplit("event: message_stop", 1)[0].rstrip()

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(payload.encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="anthropic")

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in body
        assert "event: message_delta" in body
        assert "event: message_stop" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_proxy_server_lifecycle(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(_build_openai_content_sse("lifecycle-ok").encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)

    try:
        async with ProxyServer(
            ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "openai")
        ) as server:
            assert server.is_running is True
            status, body, _ = await _request_text(
                server.port,
                "/v1/chat/completions",
                {"model": "gpt-4", "stream": True, "messages": []},
            )
            assert status == 200
            assert "lifecycle-ok" in body
            port = server.port

        with pytest.raises(ClientConnectorError):
            await _request_text(
                port,
                "/v1/chat/completions",
                {"model": "gpt-4", "stream": True, "messages": []},
            )
    finally:
        await stop_upstream()


@pytest.mark.asyncio
async def test_proxy_stop_waits_for_in_flight_requests(veto_config_dir: str) -> None:
    request_started = asyncio.Event()
    release_upstream = asyncio.Event()

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        request_started.set()
        await release_upstream.wait()
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(_build_openai_content_sse("done").encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await _start_proxy(veto_config_dir, upstream_url, fmt="openai")

    async def make_request() -> tuple[int, str]:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"http://127.0.0.1:{server.port}/v1/chat/completions",
                json={"model": "gpt-4", "stream": True, "messages": []},
            ) as response:
                return response.status, await response.text()

    try:
        request_task = asyncio.create_task(make_request())
        await request_started.wait()
        stop_task = asyncio.create_task(server.stop())
        await asyncio.sleep(0.05)
        assert request_task.done() is False
        release_upstream.set()
        status, body = await request_task
        await stop_task
        assert status == 200
        assert "done" in body
    finally:
        release_upstream.set()
        if server.is_running:
            await server.stop()
        await stop_upstream()
