"""
Aiohttp-based Veto intercept proxy.
"""

from __future__ import annotations

import codecs
import json
from typing import Any, cast

import aiohttp
from aiohttp import ClientConnectionError, ClientResponse, web
from yarl import URL

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
from veto.proxy.types import ProxyConfig, ResolvedProxyFormat

MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


class ProxyServer:
    def __init__(self, config: ProxyConfig):
        self.config = config
        self._veto: Veto | None = None
        self._app: web.Application | None = None
        self._session: aiohttp.ClientSession | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._port: int | None = None

    @property
    def port(self) -> int:
        if self._port is None:
            raise RuntimeError("Proxy server is not started")
        return self._port

    @property
    def is_running(self) -> bool:
        return self._runner is not None and self._site is not None and self._port is not None

    async def start(self) -> "ProxyServer":
        if self.is_running:
            return self

        self._veto = await Veto.init(VetoOptions(config_dir=self.config.config_dir))
        self._session = aiohttp.ClientSession(auto_decompress=False)
        self._app = web.Application()
        self._app.router.add_route("*", "/{tail:.*}", self._handle_request)
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host="127.0.0.1", port=self.config.port)

        try:
            await self._site.start()
        except Exception:
            await self.stop()
            raise

        server = self._site._server
        if server is None or not server.sockets:
            await self.stop()
            raise RuntimeError("Proxy server failed to start")

        self._port = int(server.sockets[0].getsockname()[1])
        return self

    async def stop(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

        if self._runner is not None:
            await self._runner.cleanup()
        self._runner = None
        self._site = None
        self._app = None
        self._port = None

        if self._veto is not None:
            await self._veto._cloud_client.close()
        self._veto = None

    async def close(self) -> None:
        await self.stop()

    async def __aenter__(self) -> "ProxyServer":
        return await self.start()

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        _ = (exc_type, exc, tb)
        await self.stop()

    def _require_runtime(self) -> tuple[Veto, aiohttp.ClientSession]:
        if self._veto is None or self._session is None:
            raise RuntimeError("Proxy server is not started")
        return self._veto, self._session

    def _warn(self, message: str) -> None:
        veto, _ = self._require_runtime()
        veto._logger.warn(message)

    def _error(self, message: str) -> None:
        veto, _ = self._require_runtime()
        veto._logger.error(message)

    def _resolve_format(self) -> ResolvedProxyFormat:
        if self.config.format in ("openai", "anthropic"):
            return self.config.format
        return "anthropic" if "anthropic" in self.config.target else "openai"

    @staticmethod
    def _sanitize_response_headers(
        headers: aiohttp.typedefs.LooseHeaders,
        *,
        streaming: bool,
        content_length: int | None = None,
    ) -> dict[str, str]:
        sanitized: dict[str, str] = {}
        for key, value in dict(headers).items():
            lower = key.lower()
            if lower in HOP_BY_HOP_HEADERS:
                continue
            if streaming and lower == "content-length":
                continue
            sanitized[key] = str(value)
        if content_length is not None:
            sanitized["Content-Length"] = str(content_length)
        return sanitized

    def _build_upstream_url(self, request: web.Request) -> URL:
        target = URL(self.config.target)
        return target.with_path(request.rel_url.path).with_query(request.rel_url.query)

    def _build_upstream_headers(
        self,
        request: web.Request,
        body_length: int,
        *,
        intercepting: bool,
    ) -> dict[str, str]:
        target = URL(self.config.target)
        headers = {key: value for key, value in request.headers.items()}
        headers["Host"] = target.authority
        headers.pop("Content-Length", None)
        if intercepting:
            headers["Accept-Encoding"] = "identity"
        headers["Content-Length"] = str(body_length)
        return headers

    @staticmethod
    async def _read_request_body(request: web.Request) -> bytes | None:
        chunks: list[bytes] = []
        body_size = 0
        async for chunk in request.content.iter_chunked(65536):
            body_size += len(chunk)
            if body_size > MAX_REQUEST_BODY_BYTES:
                return None
            chunks.append(chunk)
        return b"".join(chunks)

    async def _guard_tool_call(
        self,
        name: str,
        arguments: dict[str, Any],
    ) -> tuple[bool, str]:
        veto, _ = self._require_runtime()
        try:
            result = await veto.guard(name, arguments)
        except Exception as exc:
            self._error(f"[veto intercept] Unexpected guard error: {exc}")
            return True, "Tool call validation failed"

        if result.decision != "allow":
            return True, result.reason or f"Tool call '{name}' blocked"
        return False, ""

    async def _proxy_passthrough(
        self,
        request: web.Request,
        upstream: ClientResponse,
    ) -> web.StreamResponse:
        response = web.StreamResponse(
            status=upstream.status,
            headers=self._sanitize_response_headers(upstream.headers, streaming=False),
        )
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(65536):
            await response.write(chunk)
        await response.write_eof()
        return response

    async def _intercept_openai_non_stream_response(
        self,
        upstream: ClientResponse,
    ) -> web.Response:
        raw_body = await upstream.read()
        response_body = raw_body.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(response_body)
        except json.JSONDecodeError:
            return web.Response(
                status=upstream.status,
                headers=self._sanitize_response_headers(
                    upstream.headers,
                    streaming=False,
                    content_length=len(raw_body),
                ),
                body=raw_body,
            )

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
                    fn = tool_call.get("function")
                    if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
                        continue
                    arguments: dict[str, Any] = {}
                    raw_arguments = fn.get("arguments")
                    if isinstance(raw_arguments, str):
                        try:
                            parsed_arguments = json.loads(raw_arguments)
                            if isinstance(parsed_arguments, dict):
                                arguments = parsed_arguments
                        except json.JSONDecodeError:
                            self._warn(
                                f"[veto intercept] Malformed tool arguments for '{fn['name']}', validating with empty args"
                            )
                    blocked, block_reason = await self._guard_tool_call(fn["name"], arguments)
                    if blocked:
                        break
                if blocked:
                    break

        if blocked and isinstance(parsed, dict):
            blocked_response = {
                **parsed,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": f"[BLOCKED by veto] {block_reason}",
                        },
                        "finish_reason": "stop",
                    }
                ],
            }
            body = json.dumps(blocked_response).encode("utf-8")
            return web.Response(
                status=200,
                headers=self._sanitize_response_headers(
                    upstream.headers,
                    streaming=False,
                    content_length=len(body),
                ),
                body=body,
            )

        return web.Response(
            status=upstream.status,
            headers=self._sanitize_response_headers(
                upstream.headers,
                streaming=False,
                content_length=len(raw_body),
            ),
            body=raw_body,
        )

    async def _intercept_anthropic_non_stream_response(
        self,
        upstream: ClientResponse,
    ) -> web.Response:
        raw_body = await upstream.read()
        response_body = raw_body.decode("utf-8", errors="replace")
        try:
            parsed = json.loads(response_body)
        except json.JSONDecodeError:
            return web.Response(
                status=upstream.status,
                headers=self._sanitize_response_headers(
                    upstream.headers,
                    streaming=False,
                    content_length=len(raw_body),
                ),
                body=raw_body,
            )

        blocked = False
        block_reason = "Tool call blocked by veto policy"
        content = parsed.get("content") if isinstance(parsed, dict) else None
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = block.get("name") if isinstance(block.get("name"), str) else ""
                arguments = block.get("input") if isinstance(block.get("input"), dict) else {}
                blocked, block_reason = await self._guard_tool_call(name, arguments)
                if blocked:
                    break

        if blocked and isinstance(parsed, dict):
            blocked_response = {
                **parsed,
                "content": [{"type": "text", "text": f"[BLOCKED by veto] {block_reason}"}],
                "stop_reason": "end_turn",
            }
            body = json.dumps(blocked_response).encode("utf-8")
            return web.Response(
                status=200,
                headers=self._sanitize_response_headers(
                    upstream.headers,
                    streaming=False,
                    content_length=len(body),
                ),
                body=body,
            )

        return web.Response(
            status=upstream.status,
            headers=self._sanitize_response_headers(
                upstream.headers,
                streaming=False,
                content_length=len(raw_body),
            ),
            body=raw_body,
        )

    async def _intercept_openai_sse_stream(
        self,
        request: web.Request,
        upstream: ClientResponse,
    ) -> web.StreamResponse:
        response = web.StreamResponse(
            status=upstream.status,
            headers=self._sanitize_response_headers(upstream.headers, streaming=True),
        )
        await response.prepare(request)

        decoder = codecs.getincrementaldecoder("utf-8")()
        partial = ""
        pending_tool_calls: dict[int, PendingToolCall] = {}
        buffered_lines: list[str] = []
        buffered_bytes = 0
        mode = "passthrough"
        buffer_overflowed = False

        async def write_line(line: str) -> None:
            await response.write((line + "\n").encode("utf-8"))

        async def flush_buffer() -> None:
            nonlocal buffered_lines, buffered_bytes
            for line in buffered_lines:
                await write_line(line)
            buffered_lines = []
            buffered_bytes = 0

        async for raw_chunk in upstream.content.iter_chunked(65536):
            partial += decoder.decode(raw_chunk)
            lines = partial.split("\n")
            partial = lines.pop() if lines else ""

            for raw_line in lines:
                line = raw_line[:-1] if raw_line.endswith("\r") else raw_line
                parsed = parse_sse_line(line)

                if parsed.done:
                    if mode == "buffer":
                        await flush_buffer()
                    await response.write(b"data: [DONE]\n\n")
                    continue

                if mode == "overflow":
                    await write_line(line)
                    continue

                if mode == "passthrough":
                    if parsed.has_tool_calls:
                        mode = "buffer"
                    else:
                        await write_line(line)
                        continue

                if parsed.data is not None:
                    merge_tool_call_deltas(pending_tool_calls, parsed.data)

                buffered_lines.append(line)
                buffered_bytes += len(line.encode("utf-8"))

                if buffered_bytes > self.config.max_buffer_bytes:
                    buffer_overflowed = True
                    mode = "overflow"
                    await flush_buffer()
                    self._warn("[veto intercept] Buffer limit exceeded — flushing without validation")
                    continue

                if parsed.finish_reason_tool_calls:
                    blocked = False
                    block_reason = "Tool call blocked by veto policy"
                    for tool_call in pending_tool_calls.values():
                        finalized = finalize_tool_call(tool_call, self._warn)
                        blocked, block_reason = await self._guard_tool_call(
                            str(finalized["name"]),
                            cast(dict[str, Any], finalized["arguments"]),
                        )
                        if blocked:
                            break

                    if blocked:
                        buffered_lines = []
                        buffered_bytes = 0
                        await response.write(synth_blocked_event(block_reason).encode("utf-8"))
                    else:
                        await flush_buffer()

                    mode = "passthrough"
                    pending_tool_calls.clear()

        partial += decoder.decode(b"", final=True)
        if partial.strip():
            await response.write((partial + "\n").encode("utf-8"))

        if mode == "buffer" and not buffer_overflowed:
            await flush_buffer()

        await response.write_eof()
        return response

    async def _intercept_anthropic_sse_stream(
        self,
        request: web.Request,
        upstream: ClientResponse,
    ) -> web.StreamResponse:
        response = web.StreamResponse(
            status=upstream.status,
            headers=self._sanitize_response_headers(upstream.headers, streaming=True),
        )
        await response.prepare(request)

        decoder = codecs.getincrementaldecoder("utf-8")()
        partial = ""
        pending_tool_uses: dict[int, AnthropicPendingToolUse] = {}
        buffered_chunks: list[str] = []
        buffered_bytes = 0
        mode = "passthrough"
        buffer_overflowed = False
        tool_use_indexes: set[int] = set()
        event_line_buffer: list[str] = []

        async def flush_buffer() -> None:
            nonlocal buffered_chunks, buffered_bytes
            for chunk in buffered_chunks:
                await response.write(chunk.encode("utf-8"))
            buffered_chunks = []
            buffered_bytes = 0

        async for raw_chunk in upstream.content.iter_chunked(65536):
            partial += decoder.decode(raw_chunk)
            lines = partial.split("\n")
            partial = lines.pop() if lines else ""

            for raw_line in lines:
                line = raw_line[:-1] if raw_line.endswith("\r") else raw_line
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

                if parsed.event_type == "content_block_start" and parsed.data is not None:
                    block = parsed.data.get("content_block")
                    index = parsed.data.get("index")
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "tool_use"
                        and isinstance(index, int)
                    ):
                        tool_use_indexes.add(index)

                event_index = parsed.data.get("index") if isinstance(parsed.data, dict) else None
                is_tool_use_event = parsed.has_tool_use or (
                    parsed.tool_use_stop
                    and isinstance(event_index, int)
                    and event_index in tool_use_indexes
                )

                if mode == "overflow":
                    await response.write(sse_block.encode("utf-8"))
                    continue

                if mode == "passthrough":
                    if is_tool_use_event:
                        mode = "buffer"
                    else:
                        await response.write(sse_block.encode("utf-8"))
                        continue

                if parsed.data is not None and parsed.event_type is not None:
                    merge_anthropic_tool_use_delta(
                        pending_tool_uses,
                        parsed.data,
                        parsed.event_type,
                    )

                buffered_chunks.append(sse_block)
                buffered_bytes += len(sse_block.encode("utf-8"))

                if buffered_bytes > self.config.max_buffer_bytes:
                    buffer_overflowed = True
                    mode = "overflow"
                    await flush_buffer()
                    self._warn("[veto intercept] Buffer limit exceeded — flushing without validation")
                    continue

                if parsed.message_stop:
                    blocked = False
                    block_reason = "Tool call blocked by veto policy"
                    for tool_use in pending_tool_uses.values():
                        finalized = finalize_anthropic_tool_use(tool_use, self._warn)
                        blocked, block_reason = await self._guard_tool_call(
                            str(finalized["name"]),
                            cast(dict[str, Any], finalized["arguments"]),
                        )
                        if blocked:
                            break

                    if blocked:
                        buffered_chunks = []
                        buffered_bytes = 0
                        await response.write(synth_anthropic_blocked_event(block_reason).encode("utf-8"))
                    else:
                        await flush_buffer()

                    mode = "passthrough"
                    pending_tool_uses.clear()
                    tool_use_indexes.clear()

        partial += decoder.decode(b"", final=True)
        if partial.strip():
            await response.write((partial + "\n").encode("utf-8"))

        if mode == "buffer" and not buffer_overflowed:
            await flush_buffer()

        await response.write_eof()
        return response

    async def _handle_request(self, request: web.Request) -> web.StreamResponse | web.Response:
        _, session = self._require_runtime()
        req_url = str(request.rel_url)
        fmt = self._resolve_format()
        is_intercept_target = "/v1/messages" in req_url if fmt == "anthropic" else "/chat/completions" in req_url

        body = await self._read_request_body(request)
        if body is None:
            return web.Response(status=413, text="Request body too large", content_type="text/plain")

        parsed_body: dict[str, Any] | None = None
        if is_intercept_target:
            try:
                loaded = json.loads(body.decode("utf-8"))
                if isinstance(loaded, dict):
                    parsed_body = loaded
            except (UnicodeDecodeError, json.JSONDecodeError):
                parsed_body = None

        is_stream = parsed_body is not None and parsed_body.get("stream") is True
        upstream_url = self._build_upstream_url(request)
        upstream_headers = self._build_upstream_headers(
            request,
            len(body),
            intercepting=is_intercept_target,
        )

        try:
            async with session.request(
                method=request.method,
                url=upstream_url,
                data=body,
                headers=upstream_headers,
                allow_redirects=False,
            ) as upstream:
                if not is_intercept_target:
                    return await self._proxy_passthrough(request, upstream)

                if fmt == "anthropic":
                    if is_stream:
                        return await self._intercept_anthropic_sse_stream(request, upstream)
                    return await self._intercept_anthropic_non_stream_response(upstream)

                if is_stream:
                    return await self._intercept_openai_sse_stream(request, upstream)
                return await self._intercept_openai_non_stream_response(upstream)
        except ClientConnectionError as exc:
            self._error(f"[veto intercept] Upstream connection error: {exc}")
            return web.Response(status=502, text="Bad Gateway", content_type="text/plain")
        except Exception as exc:
            self._error(f"[veto intercept] Internal proxy error: {exc}")
            return web.Response(status=500, text="Internal proxy error", content_type="text/plain")


async def start_proxy_server(config: ProxyConfig) -> ProxyServer:
    return await ProxyServer(config).start()
