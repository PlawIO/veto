from __future__ import annotations

import contextlib
import socket
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp import web

from veto.cloud.client import (
    RuntimeActionTimeoutError,
    VetoCloudClient,
    VetoCloudConfig,
)
from veto.cloud.types import ApprovalPollOptions, RuntimeActionCreateRequest


@contextlib.asynccontextmanager
async def run_test_server() -> AsyncIterator[SimpleNamespace]:
    requests: list[dict[str, Any]] = []
    wait_responses: list[dict[str, Any]] = []
    app = web.Application()

    async def create_runtime_action(request: web.Request) -> web.Response:
        body = await request.json()
        requests.append(
            {
                "method": request.method,
                "path": request.path,
                "path_qs": request.path_qs,
                "query": dict(request.query),
                "headers": dict(request.headers),
                "json": body,
            }
        )
        return web.json_response(
            {
                "id": "act_123",
                "status": "pending",
                "approvalId": "appr_123",
                "decisionId": "dec_123",
                "agentId": body["agentId"],
                "agentName": body.get("agentName"),
                "actionIntent": body["actionIntent"],
                "toolName": body["toolName"],
                "toolCallPayload": body["toolCallPayload"],
                "timeoutMs": body.get("timeoutSeconds", 120) * 1000,
                "riskScore": body.get("riskScore"),
                "sessionId": body.get("sessionId"),
                "metadata": body.get("metadata"),
                "payloadHash": "sha256:test",
                "payloadHashAlgorithm": "sha256-hex",
                "requestTs": 1_781_625_000_000,
                "expiresAtMs": 1_781_625_060_000,
            }
        )

    async def wait_runtime_action(request: web.Request) -> web.Response:
        requests.append(
            {
                "method": request.method,
                "path": request.path,
                "path_qs": request.path_qs,
                "query": dict(request.query),
                "headers": dict(request.headers),
            }
        )
        data = dict(
            wait_responses.pop(0)
            if wait_responses
            else {"id": request.match_info["action_id"], "status": "pending"}
        )
        status = int(data.pop("_http_status", 200))
        return web.json_response(data, status=status)

    app.router.add_post("/v1/runtime/actions", create_runtime_action)
    app.router.add_get("/v1/runtime/actions/{action_id}/wait", wait_runtime_action)
    runner = web.AppRunner(app)
    await runner.setup()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(socket.SOMAXCONN)
    sock.setblocking(False)
    port = sock.getsockname()[1]
    site = web.SockSite(runner, sock)
    await site.start()

    try:
        yield SimpleNamespace(
            base_url=f"http://127.0.0.1:{port}",
            requests=requests,
            wait_responses=wait_responses,
        )
    finally:
        await runner.cleanup()
        sock.close()


async def test_cloud_client_creates_runtime_action_for_ios_wallet() -> None:
    async with run_test_server() as server:
        client = VetoCloudClient(
            VetoCloudConfig(
                api_key="veto_test",
                base_url=server.base_url,
                retries=0,
            )
        )
        try:
            action = await client.create_runtime_action(
                RuntimeActionCreateRequest(
                    agent_id="agent_refunds",
                    agent_name="Refund Agent",
                    action_intent="Refund $500",
                    tool_name="refund_payment",
                    tool_call_payload={"charge_id": "ch_123", "amount": 500},
                    timeout_seconds=60,
                    risk_score=82,
                    session_id="sess_123",
                    metadata={"customerTier": "enterprise"},
                )
            )
        finally:
            await client.close()

    assert action.id == "act_123"
    assert action.status == "pending"
    assert action.approval_id == "appr_123"
    assert action.payload_hash == "sha256:test"

    request = server.requests[0]
    assert request["method"] == "POST"
    assert request["path"] == "/v1/runtime/actions"
    assert request["headers"]["X-Veto-API-Key"] == "veto_test"
    assert request["json"] == {
        "agentId": "agent_refunds",
        "agentName": "Refund Agent",
        "actionIntent": "Refund $500",
        "toolName": "refund_payment",
        "toolCallPayload": {"charge_id": "ch_123", "amount": 500},
        "timeoutSeconds": 60,
        "riskScore": 82,
        "sessionId": "sess_123",
        "metadata": {"customerTier": "enterprise"},
    }


async def test_cloud_client_waits_for_runtime_action_resolution() -> None:
    async with run_test_server() as server:
        server.wait_responses.append(
            {
                "id": "act_123",
                "status": "approved",
                "resolvedBy": "device_123",
                "resolvedAt": "2026-06-16T16:35:10.000Z",
            }
        )
        client = VetoCloudClient(
            VetoCloudConfig(
                api_key="veto_test",
                base_url=server.base_url,
                retries=0,
            )
        )
        try:
            action = await client.wait_runtime_action(
                "act_123",
                ApprovalPollOptions(timeout=0.5, poll_interval=0.01),
            )
        finally:
            await client.close()

    assert action.id == "act_123"
    assert action.status == "approved"
    assert action.resolved_by == "device_123"

    request = server.requests[0]
    assert request["method"] == "GET"
    assert request["path"] == "/v1/runtime/actions/act_123/wait"
    assert int(request["query"]["timeoutMs"]) >= 1000
    assert request["headers"]["X-Veto-API-Key"] == "veto_test"


async def test_cloud_client_runtime_action_timeout_keeps_last_pending_action() -> None:
    async with run_test_server() as server:
        server.wait_responses.extend(
            [
                {"id": "act_timeout", "status": "pending", "_http_status": 202}
                for _ in range(20)
            ]
        )
        client = VetoCloudClient(
            VetoCloudConfig(
                api_key="veto_test",
                base_url=server.base_url,
                retries=0,
            )
        )
        try:
            with pytest.raises(RuntimeActionTimeoutError) as exc_info:
                await client.wait_runtime_action(
                    "act_timeout",
                    ApprovalPollOptions(timeout=0.02, poll_interval=0.001),
                )
        finally:
            await client.close()

    assert exc_info.value.action_id == "act_timeout"
    assert exc_info.value.last_action is not None
    assert exc_info.value.last_action.status == "pending"
