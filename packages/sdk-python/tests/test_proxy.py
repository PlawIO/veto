"""Tests for the Python intercept proxy."""

from __future__ import annotations

import json
from pathlib import Path

import aiohttp
from aiohttp import web
import pytest
import pytest_asyncio

from veto.proxy import ProxyConfig, start_proxy_server


def _setup_veto_dir(tmp_path: Path) -> str:
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
        )
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
        )
    )
    return str(config_dir)


def _tool_call_sse(tool_name: str, args: str) -> str:
    delta_1 = json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "tc_1", "function": {"name": tool_name, "arguments": ""}}
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        }
    )
    delta_2 = json.dumps(
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [{"index": 0, "function": {"arguments": args}}]
                    },
                    "finish_reason": None,
                }
            ]
        }
    )
    finish = json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    return f"data: {delta_1}\n\ndata: {delta_2}\n\ndata: {finish}\n\ndata: [DONE]\n\n"


def _content_sse(text: str) -> str:
    chunk = json.dumps({"choices": [{"delta": {"content": text}, "finish_reason": None}]})
    done = json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]})
    return f"data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"


@pytest_asyncio.fixture
async def upstream_server() -> str:
    async def handle_chat(request: web.Request) -> web.StreamResponse:
        payload = await request.json()
        if payload.get("stream"):
            if payload.get("messages") == [{"role": "user", "content": "block"}]:
                body = _tool_call_sse("delete_file", '{"path":"/etc/hosts"}')
            else:
                body = _content_sse("hello")
            return web.Response(text=body, headers={"content-type": "text/event-stream"})
        return web.json_response({"choices": [{"message": {"content": "ok"}}]})

    async def handle_health(_: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/v1/chat/completions", handle_chat)
    app.router.add_get("/health", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    assert site._server is not None and site._server.sockets is not None
    port = site._server.sockets[0].getsockname()[1]

    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_proxy_blocks_tool_call_stream(tmp_path: Path, upstream_server: str) -> None:
    config_dir = _setup_veto_dir(tmp_path)
    server = await start_proxy_server(
        ProxyConfig(port=0, target=upstream_server, config_dir=config_dir, format="openai")
    )

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server.url}/v1/chat/completions",
                json={"model": "gpt-4", "stream": True, "messages": [{"role": "user", "content": "block"}]},
            ) as response:
                body = await response.text()
        assert "[BLOCKED by veto]" in body
        assert "[DONE]" in body
    finally:
        await server.stop()


@pytest.mark.asyncio
async def test_proxy_passthrough_stream_and_non_target_route(
    tmp_path: Path,
    upstream_server: str,
) -> None:
    config_dir = _setup_veto_dir(tmp_path)
    server = await start_proxy_server(
        ProxyConfig(port=0, target=upstream_server, config_dir=config_dir, format="openai")
    )

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{server.url}/v1/chat/completions",
                json={"model": "gpt-4", "stream": True, "messages": []},
            ) as response:
                body = await response.text()
            async with session.get(f"{server.url}/health") as response:
                health = await response.json()
        assert "hello" in body
        assert "[BLOCKED by veto]" not in body
        assert health["ok"] is True
    finally:
        await server.stop()
