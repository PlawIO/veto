"""
Integration tests for the Python proxy server.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Awaitable, Callable

import aiohttp
import pytest
from aiohttp import ClientConnectorError, web

from veto import GuardResult
from veto.proxy import ProxyConfig, ProxyServer, start_proxy_server
from veto.core.veto import Veto


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
        }
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
        }
    )
    finish = json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    return f"data: {delta1}\n\ndata: {delta2}\n\ndata: {finish}\n\ndata: [DONE]\n\n"


def _build_openai_content_sse(text: str) -> str:
    chunk = json.dumps({"choices": [{"delta": {"content": text}, "finish_reason": None}]})
    done = json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]})
    return f"data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"


def _build_anthropic_tool_use_sse(tool_name: str, input_json: str) -> str:
    return "".join(
        [
            "event: content_block_start\n"
            f"data: {json.dumps({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'toolu_1', 'name': tool_name}})}\n\n",
            "event: content_block_delta\n"
            f"data: {json.dumps({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': input_json}})}\n\n",
            "event: content_block_stop\n"
            f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n",
            "event: message_stop\n"
            "data: {}\n\n",
        ]
    )


@pytest.mark.asyncio
async def test_public_proxy_api_exports(veto_config_dir: str) -> None:
    config = ProxyConfig(
        port=8080,
        target="https://api.openai.com",
        max_buffer_bytes=1024,
        config_dir=veto_config_dir,
    )
    server = ProxyServer(config)

    assert isinstance(config, ProxyConfig)
    assert isinstance(server, ProxyServer)
    assert callable(start_proxy_server)


@pytest.mark.asyncio
async def test_openai_stream_blocked_tool_call(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        )
        await response.prepare(_request)
        await response.write(
            _build_openai_tool_call_sse("delete_file", '{"path":"/etc/hosts"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(
            port=0,
            target=upstream_url,
            max_buffer_bytes=1024 * 1024,
            config_dir=veto_config_dir,
            format="openai",
        )
    )

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" in body
        assert "data:" in body
        assert "[DONE]" in body
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_openai_stream_allowed_tool_call_passthrough(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_openai_tool_call_sse("read_file", '{"path":"/tmp/file"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "openai")
    )

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
async def test_openai_non_stream_blocked_tool_call(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.Response:
        response_body = json.dumps(
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
                                        "name": "delete_file",
                                        "arguments": '{"path":"/etc/hosts"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        )
        return web.Response(text=response_body, content_type="application/json")

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "openai")
    )

    try:
        status, body, headers = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": False, "messages": []},
        )
        assert status == 200
        assert headers["Content-Length"] == str(len(body.encode("utf-8")))
        parsed = json.loads(body)
        assert "[BLOCKED by veto]" in parsed["choices"][0]["message"]["content"]
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_anthropic_stream_blocked_tool_use(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_anthropic_tool_use_sse("delete_file", '{"path":"/etc/hosts"}').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "anthropic")
    )

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
async def test_proxy_forwards_headers_and_rewrites_host(veto_config_dir: str) -> None:
    captured: dict[str, Any] = {}

    async def upstream_handler(request: web.Request) -> web.StreamResponse:
        captured["host"] = request.headers.get("Host")
        captured["authorization"] = request.headers.get("Authorization")
        captured["content_length"] = request.headers.get("Content-Length")
        captured["body"] = await request.text()
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(_build_openai_content_sse("headers-ok").encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "openai")
    )

    try:
        payload = {"model": "gpt-4", "stream": True, "messages": []}
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            payload,
            headers={"Authorization": "Bearer test-token"},
        )
        assert status == 200
        assert "headers-ok" in body
        assert captured["authorization"] == "Bearer test-token"
        assert captured["host"] == upstream_url.removeprefix("http://")
        assert captured["content_length"] == str(len(json.dumps(payload).encode("utf-8")))
        assert json.loads(captured["body"]) == payload
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_buffer_overflow_passthrough_skips_validation(
    veto_config_dir: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 64, veto_config_dir, "openai")
    )

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "[BLOCKED by veto]" not in body
        assert "delete_file" in body
        assert calls == []
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_malformed_openai_tool_args_validate_with_empty_args(
    veto_config_dir: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict[str, Any]] = []

    async def fake_guard(self: Veto, name: str, arguments: dict[str, Any]) -> GuardResult:
        _ = name
        seen.append(arguments)
        return GuardResult(decision="allow")

    monkeypatch.setattr(Veto, "guard", fake_guard)

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_openai_tool_call_sse("delete_file", '{"path":').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "openai")
    )

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "delete_file" in body
        assert seen == [{}]
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_malformed_anthropic_tool_input_validates_with_empty_args(
    veto_config_dir: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[dict[str, Any]] = []

    async def fake_guard(self: Veto, name: str, arguments: dict[str, Any]) -> GuardResult:
        _ = name
        seen.append(arguments)
        return GuardResult(decision="allow")

    monkeypatch.setattr(Veto, "guard", fake_guard)

    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(
            _build_anthropic_tool_use_sse("delete_file", '{"path":').encode("utf-8")
        )
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = await start_proxy_server(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "anthropic")
    )

    try:
        status, body, _ = await _request_text(
            server.port,
            "/v1/messages",
            {"model": "claude-sonnet-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "event: content_block_start" in body
        assert seen == [{}]
    finally:
        await server.stop()
        await stop_upstream()


@pytest.mark.asyncio
async def test_proxy_server_lifecycle_start_and_stop(veto_config_dir: str) -> None:
    async def upstream_handler(_request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(_request)
        await response.write(_build_openai_content_sse("lifecycle-ok").encode("utf-8"))
        await response.write_eof()
        return response

    upstream_url, stop_upstream = await _start_server(upstream_handler)
    server = ProxyServer(
        ProxyConfig(0, upstream_url, 1024 * 1024, veto_config_dir, "openai")
    )

    try:
        assert server.is_running is False
        await server.start()
        assert server.is_running is True

        status, body, _ = await _request_text(
            server.port,
            "/v1/chat/completions",
            {"model": "gpt-4", "stream": True, "messages": []},
        )
        assert status == 200
        assert "lifecycle-ok" in body

        port = server.port
        await server.stop()
        assert server.is_running is False

        with pytest.raises(ClientConnectorError):
            await _request_text(
                port,
                "/v1/chat/completions",
                {"model": "gpt-4", "stream": True, "messages": []},
            )
    finally:
        await server.stop()
        await stop_upstream()
