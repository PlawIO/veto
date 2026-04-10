"""Aiohttp-powered Veto intercept proxy."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp import web

from veto.core.veto import Veto, VetoOptions
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
from veto.proxy.types import ProxyConfig

MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024


def _resolve_format(config: ProxyConfig) -> str:
    if config.format in ("openai", "anthropic"):
        return config.format
    return "anthropic" if "anthropic" in config.target else "openai"


def _copy_stream_headers(headers: aiohttp.typedefs.LooseHeaders) -> dict[str, str]:
    copied = dict(headers)
    for key in ("Transfer-Encoding", "transfer-encoding", "Content-Length", "content-length"):
        copied.pop(key, None)
    return {str(k): str(v) for k, v in copied.items()}


def _buffered_response(status: int, headers: aiohttp.typedefs.LooseHeaders, body: bytes) -> web.Response:
    out_headers = _copy_stream_headers(headers)
    out_headers["Content-Length"] = str(len(body))
    return web.Response(status=status, headers=out_headers, body=body)


class ProxyServer:
    """Lifecycle wrapper around the proxy app."""

    def __init__(self, config: ProxyConfig, veto: Veto):
        self._config = config
        self._veto = veto
        self._app = web.Application()
        self._app.router.add_route("*", "/{tail:.*}", self._handle_request)
        self._runner = web.AppRunner(self._app)
        self._site: Optional[web.TCPSite] = None
        self._upstream_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None))
        self._host = "127.0.0.1"
        self._port = config.port

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        return self._port

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self._port}"

    async def start(self) -> None:
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self._host, self._config.port)
        await self._site.start()
        if self._site._server and self._site._server.sockets:
            host, port = self._site._server.sockets[0].getsockname()[:2]
            self._host = str(host)
            self._port = int(port)

    async def stop(self) -> None:
        if self._site is not None:
            await self._site.stop()
            self._site = None
        await self._runner.cleanup()
        await self._upstream_session.close()
        cloud_client = getattr(self._veto, "_cloud_client", None)
        if cloud_client is not None and hasattr(cloud_client, "close"):
            await cloud_client.close()

    async def _handle_request(self, request: web.Request) -> web.StreamResponse:
        target_base = self._config.target.rstrip("/") + "/"
        request_path = request.rel_url.path_qs.lstrip("/")
        upstream_url = urljoin(target_base, request_path)
        format_name = _resolve_format(self._config)
        is_intercept_target = (
            "/v1/messages" in request.path
            if format_name == "anthropic"
            else "/chat/completions" in request.path
        )

        body = await request.read()
        if len(body) > MAX_REQUEST_BODY_BYTES:
            return web.Response(status=413, text="Request body too large")

        parsed_body: Optional[dict[str, Any]] = None
        if is_intercept_target:
            try:
                candidate = json.loads(body.decode("utf-8")) if body else {}
                if isinstance(candidate, dict):
                    parsed_body = candidate
            except json.JSONDecodeError:
                parsed_body = None

        is_stream = parsed_body is not None and parsed_body.get("stream") is True

        target_parts = urlsplit(self._config.target)
        headers = {k: v for k, v in request.headers.items() if k.lower() not in {"host", "content-length"}}
        if target_parts.netloc:
            headers["host"] = target_parts.netloc

        try:
            async with self._upstream_session.request(
                request.method,
                upstream_url,
                headers=headers,
                data=body,
            ) as upstream_response:
                if not is_intercept_target:
                    return _buffered_response(
                        upstream_response.status,
                        upstream_response.headers,
                        await upstream_response.read(),
                    )

                if format_name == "anthropic":
                    if is_stream:
                        return await self._intercept_anthropic_sse(request, upstream_response)
                    return await self._intercept_anthropic_non_stream(upstream_response)

                if is_stream:
                    return await self._intercept_openai_sse(request, upstream_response)
                return await self._intercept_openai_non_stream(upstream_response)
        except aiohttp.ClientError:
            return web.Response(status=502, text="Bad Gateway")

    async def _intercept_openai_non_stream(self, upstream_response: aiohttp.ClientResponse) -> web.Response:
        body_bytes = await upstream_response.read()
        body_text = body_bytes.decode("utf-8")
        try:
            parsed = json.loads(body_text)
        except json.JSONDecodeError:
            return _buffered_response(upstream_response.status, upstream_response.headers, body_bytes)

        blocked = False
        block_reason = "Tool call blocked by veto policy"
        choices = parsed.get("choices") if isinstance(parsed, dict) else None
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                message = choice.get("message")
                if not isinstance(message, dict):
                    continue
                tool_calls = message.get("tool_calls")
                if not isinstance(tool_calls, list):
                    continue
                for tool_call in tool_calls:
                    if not isinstance(tool_call, dict):
                        continue
                    function = tool_call.get("function")
                    if not isinstance(function, dict) or not isinstance(function.get("name"), str):
                        continue
                    args: dict[str, Any] = {}
                    raw_args = function.get("arguments")
                    if isinstance(raw_args, str):
                        try:
                            parsed_args = json.loads(raw_args)
                            if isinstance(parsed_args, dict):
                                args = parsed_args
                        except json.JSONDecodeError:
                            pass
                    result = await self._veto.guard(function["name"], args)
                    if result.decision != "allow":
                        blocked = True
                        block_reason = result.reason or f"Tool call '{function['name']}' blocked"
                        break
                if blocked:
                    break

        if blocked and isinstance(parsed, dict):
            blocked_response = {
                **parsed,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": f"[BLOCKED by veto] {block_reason}"},
                        "finish_reason": "stop",
                    }
                ],
            }
            return _buffered_response(200, upstream_response.headers, json.dumps(blocked_response).encode("utf-8"))

        return _buffered_response(upstream_response.status, upstream_response.headers, body_bytes)

    async def _intercept_openai_sse(
        self,
        request: web.Request,
        upstream_response: aiohttp.ClientResponse,
    ) -> web.StreamResponse:
        response = web.StreamResponse(status=upstream_response.status, headers=_copy_stream_headers(upstream_response.headers))
        await response.prepare(request)

        partial = ""
        pending_tool_calls: dict[int, PendingToolCall] = {}
        buffered_lines: list[str] = []
        buffered_bytes = 0
        mode = "passthrough"

        async for raw_chunk in upstream_response.content.iter_any():
            chunk = raw_chunk.decode("utf-8")
            partial += chunk
            lines = partial.split("\n")
            partial = lines.pop() or ""

            for raw_line in lines:
                line = raw_line.rstrip("\r")
                parsed = parse_sse_line(line)

                if parsed.done:
                    if mode == "buffer":
                        for buffered in buffered_lines:
                            await response.write((buffered + "\n").encode("utf-8"))
                        buffered_lines = []
                    await response.write(b"data: [DONE]\n\n")
                    continue

                if mode == "overflow":
                    await response.write((line + "\n").encode("utf-8"))
                    continue

                if mode == "passthrough":
                    if parsed.has_tool_calls:
                        mode = "buffer"
                    else:
                        await response.write((line + "\n").encode("utf-8"))
                        continue

                if parsed.data is not None:
                    merge_tool_call_deltas(pending_tool_calls, parsed.data)

                buffered_lines.append(line)
                buffered_bytes += len(line.encode("utf-8"))

                if buffered_bytes > self._config.max_buffer_bytes:
                    mode = "overflow"
                    for buffered in buffered_lines:
                        await response.write((buffered + "\n").encode("utf-8"))
                    buffered_lines = []
                    buffered_bytes = 0
                    continue

                if parsed.finish_reason_tool_calls:
                    blocked = False
                    block_reason = "Tool call blocked by veto policy"
                    for tool_call in pending_tool_calls.values():
                        finalized = finalize_tool_call(tool_call)
                        result = await self._veto.guard(finalized["name"], finalized["arguments"])
                        if result.decision != "allow":
                            blocked = True
                            block_reason = result.reason or f"Tool call '{finalized['name']}' blocked"
                            break
                    if blocked:
                        buffered_lines = []
                        buffered_bytes = 0
                        await response.write(synth_blocked_event(block_reason).encode("utf-8"))
                    else:
                        for buffered in buffered_lines:
                            await response.write((buffered + "\n").encode("utf-8"))
                        buffered_lines = []
                        buffered_bytes = 0
                    mode = "passthrough"
                    pending_tool_calls.clear()

        if partial.strip():
            await response.write((partial + "\n").encode("utf-8"))
        if mode == "buffer" and buffered_lines:
            for buffered in buffered_lines:
                await response.write((buffered + "\n").encode("utf-8"))
        await response.write_eof()
        return response

    async def _intercept_anthropic_non_stream(self, upstream_response: aiohttp.ClientResponse) -> web.Response:
        body_bytes = await upstream_response.read()
        body_text = body_bytes.decode("utf-8")
        try:
            parsed = json.loads(body_text)
        except json.JSONDecodeError:
            return _buffered_response(upstream_response.status, upstream_response.headers, body_bytes)

        blocked = False
        block_reason = "Tool call blocked by veto policy"
        content = parsed.get("content") if isinstance(parsed, dict) else None
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = block.get("name") if isinstance(block.get("name"), str) else ""
                input_data = block.get("input") if isinstance(block.get("input"), dict) else {}
                result = await self._veto.guard(name, input_data)
                if result.decision != "allow":
                    blocked = True
                    block_reason = result.reason or f"Tool call '{name}' blocked"
                    break

        if blocked and isinstance(parsed, dict):
            blocked_response = {
                **parsed,
                "content": [{"type": "text", "text": f"[BLOCKED by veto] {block_reason}"}],
                "stop_reason": "end_turn",
            }
            return _buffered_response(200, upstream_response.headers, json.dumps(blocked_response).encode("utf-8"))

        return _buffered_response(upstream_response.status, upstream_response.headers, body_bytes)

    async def _intercept_anthropic_sse(
        self,
        request: web.Request,
        upstream_response: aiohttp.ClientResponse,
    ) -> web.StreamResponse:
        response = web.StreamResponse(status=upstream_response.status, headers=_copy_stream_headers(upstream_response.headers))
        await response.prepare(request)

        partial = ""
        pending_tool_uses: dict[int, AnthropicPendingToolUse] = {}
        tool_use_indexes: set[int] = set()
        buffered_chunks: list[str] = []
        buffered_bytes = 0
        mode = "passthrough"
        event_line_buffer: list[str] = []

        async for raw_chunk in upstream_response.content.iter_any():
            chunk = raw_chunk.decode("utf-8")
            partial += chunk
            lines = partial.split("\n")
            partial = lines.pop() or ""

            for raw_line in lines:
                line = raw_line.rstrip("\r")
                if line != "":
                    event_line_buffer.append(line)
                    continue

                if not event_line_buffer:
                    if mode == "passthrough":
                        await response.write(b"\n")
                    continue

                sse_block = "\n".join(event_line_buffer) + "\n\n"
                parsed = parse_anthropic_sse_lines(event_line_buffer)
                event_line_buffer = []

                if parsed.event_type == "content_block_start" and isinstance(parsed.data, dict):
                    block = parsed.data.get("content_block")
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        index = parsed.data.get("index") if isinstance(parsed.data.get("index"), int) else 0
                        tool_use_indexes.add(index)

                current_index = parsed.data.get("index") if isinstance(parsed.data, dict) and isinstance(parsed.data.get("index"), int) else -1
                is_tool_use_event = parsed.has_tool_use or (parsed.tool_use_stop and current_index in tool_use_indexes)

                if mode == "overflow":
                    await response.write(sse_block.encode("utf-8"))
                    continue

                if mode == "passthrough":
                    if is_tool_use_event:
                        mode = "buffer"
                    else:
                        await response.write(sse_block.encode("utf-8"))
                        continue

                if isinstance(parsed.data, dict) and parsed.event_type is not None:
                    merge_anthropic_tool_use_delta(pending_tool_uses, parsed.data, parsed.event_type)

                buffered_chunks.append(sse_block)
                buffered_bytes += len(sse_block.encode("utf-8"))

                if buffered_bytes > self._config.max_buffer_bytes:
                    mode = "overflow"
                    for buffered in buffered_chunks:
                        await response.write(buffered.encode("utf-8"))
                    buffered_chunks = []
                    buffered_bytes = 0
                    continue

                if parsed.message_stop:
                    blocked = False
                    block_reason = "Tool call blocked by veto policy"
                    for tool_use in pending_tool_uses.values():
                        finalized = finalize_anthropic_tool_use(tool_use)
                        result = await self._veto.guard(finalized["name"], finalized["arguments"])
                        if result.decision != "allow":
                            blocked = True
                            block_reason = result.reason or f"Tool call '{finalized['name']}' blocked"
                            break
                    if blocked:
                        buffered_chunks = []
                        buffered_bytes = 0
                        await response.write(synth_anthropic_blocked_event(block_reason).encode("utf-8"))
                    else:
                        for buffered in buffered_chunks:
                            await response.write(buffered.encode("utf-8"))
                        buffered_chunks = []
                        buffered_bytes = 0
                    mode = "passthrough"
                    pending_tool_uses.clear()
                    tool_use_indexes.clear()

        if partial.strip():
            await response.write((partial + "\n").encode("utf-8"))
        if mode == "buffer" and buffered_chunks:
            for buffered in buffered_chunks:
                await response.write(buffered.encode("utf-8"))
        await response.write_eof()
        return response


async def start_proxy_server(config: ProxyConfig) -> ProxyServer:
    veto = await Veto.init(VetoOptions(config_dir=config.config_dir, log_level="silent"))
    server = ProxyServer(config, veto)
    try:
        await server.start()
    except Exception:
        await server.stop()
        raise
    return server
