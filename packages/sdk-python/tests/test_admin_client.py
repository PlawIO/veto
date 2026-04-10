from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import AsyncIterator, Awaitable, Callable
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp import web

from veto import (
    AdminApproval,
    AdminDecision,
    AdminOutputRule,
    AdminSessionConstraints,
    AdminTool,
    ApiKeyCreated,
    ApiKeyInfo,
    BatchResolveApprovalItem,
    BatchResolveApprovalsResponse,
    Constraint,
    CreatePolicyDraftInput,
    CreatePolicyInput,
    CreateUpstreamInput,
    DecisionQuery,
    DecisionStats,
    EventSubscription,
    LlmConfig,
    McpUpstream,
    PaginatedResult,
    Policy,
    PolicyDraft,
    ProjectCreated,
    UpdatePolicyInput,
    UpstreamTestResult,
    VetoAdmin,
    VetoAdminError,
    VetoAdminEvent,
    VetoAdminOptions,
)

Handler = Callable[[web.Request, Any], Awaitable[web.StreamResponse]]


@contextlib.asynccontextmanager
async def run_test_server(
    routes: list[tuple[str, str, Handler]],
) -> AsyncIterator[SimpleNamespace]:
    requests: list[dict[str, Any]] = []
    app = web.Application()

    for method, path, handler in routes:
        async def wrapped(request: web.Request, handler: Handler = handler) -> web.StreamResponse:
            try:
                body = await request.json()
            except Exception:
                body = None
            requests.append(
                {
                    "method": request.method,
                    "path": request.path,
                    "path_qs": request.path_qs,
                    "query": dict(request.query),
                    "headers": dict(request.headers),
                    "body": body,
                }
            )
            return await handler(request, body)

        app.router.add_route(method, path, wrapped)

    runner = web.AppRunner(app)
    await runner.setup()

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()

    try:
        yield SimpleNamespace(base_url=f"http://127.0.0.1:{port}", requests=requests)
    finally:
        await runner.cleanup()


def make_admin(base_url: str, timeout: int = 30_000) -> VetoAdmin:
    return VetoAdmin(VetoAdminOptions(apiKey="test-key", baseUrl=base_url, timeout=timeout))


class TestVetoAdmin:
    def test_constructor_validation_and_exports(self) -> None:
        with pytest.raises(ValueError, match="VetoAdmin requires an apiKey"):
            VetoAdmin()

        admin = VetoAdmin(apiKey="test-key")

        assert admin.apiKey == "test-key"
        assert admin.baseUrl == "https://api.veto.so"
        assert admin.timeout == 30_000
        assert Policy is not None
        assert Constraint is not None
        assert AdminOutputRule is not None
        assert LlmConfig is not None
        assert AdminSessionConstraints is not None
        assert CreatePolicyInput is not None
        assert UpdatePolicyInput is not None
        assert AdminDecision is not None
        assert DecisionQuery is not None
        assert DecisionStats is not None
        assert PaginatedResult is not None
        assert AdminApproval is not None
        assert AdminTool is not None
        assert PolicyDraft is not None
        assert CreatePolicyDraftInput is not None
        assert McpUpstream is not None
        assert CreateUpstreamInput is not None
        assert UpstreamTestResult is not None
        assert ApiKeyInfo is not None
        assert ApiKeyCreated is not None
        assert ProjectCreated is not None
        assert VetoAdminEvent is not None
        assert EventSubscription is not None
        assert BatchResolveApprovalItem is not None
        assert BatchResolveApprovalsResponse is not None

    async def test_policies_methods_and_export_text(self) -> None:
        async def list_policies(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(
                {
                    "data": [
                        {
                            "_id": "pol_1",
                            "toolName": "transfer_funds",
                            "mode": "deterministic",
                            "version": 2,
                            "isActive": True,
                            "constraints": [{"argumentName": "amount", "enabled": True, "maximum": 1000}],
                            "outputRules": [{"id": "or_1", "name": "mask", "action": "redact"}],
                            "llmConfig": {"description": "desc", "exceptions": ["ok"]},
                            "sessionConstraints": {"maxCalls": 3},
                            "projectId": "proj_1",
                            "createdAt": "2026-01-01T00:00:00.000Z",
                        }
                    ]
                }
            )

        async def get_policy(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(
                {
                    "_id": "pol_1",
                    "toolName": "transfer_funds",
                    "mode": "deterministic",
                    "version": 2,
                    "isActive": True,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                }
            )

        async def create_policy(_request: web.Request, body: Any) -> web.Response:
            assert body == {
                "toolName": "transfer_funds",
                "mode": "deterministic",
                "projectId": "proj_1",
                "constraints": [{"argumentName": "amount", "enabled": True, "maximum": 1000.0}],
            }
            return web.json_response(
                {
                    "_id": "pol_created",
                    "toolName": "transfer_funds",
                    "mode": "deterministic",
                    "version": 1,
                    "isActive": False,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                },
                status=201,
            )

        async def update_policy(_request: web.Request, body: Any) -> web.Response:
            assert body == {"mode": "llm", "llmConfig": {"description": "review", "exceptions": ["safe"]}}
            return web.json_response(
                {
                    "_id": "pol_updated",
                    "toolName": "transfer_funds",
                    "mode": "llm",
                    "version": 3,
                    "isActive": True,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                }
            )

        async def no_content(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(status=204)

        async def export_policies(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(text="policies: []", content_type="text/plain")

        routes = [
            ("GET", "/v1/policies", list_policies),
            ("GET", "/v1/policies/transfer_funds", get_policy),
            ("POST", "/v1/policies", create_policy),
            ("PUT", "/v1/policies/transfer_funds", update_policy),
            ("DELETE", "/v1/policies/transfer_funds", no_content),
            ("POST", "/v1/policies/transfer_funds/activate", no_content),
            ("POST", "/v1/policies/transfer_funds/deactivate", no_content),
            ("GET", "/v1/policies/export", export_policies),
        ]

        async with run_test_server(routes) as server:
            admin = make_admin(server.base_url)
            policies = await admin.listPolicies({"projectId": "proj_1"})
            policy = await admin.getPolicy("transfer_funds")
            created = await admin.createPolicy(
                CreatePolicyInput(
                    toolName="transfer_funds",
                    projectId="proj_1",
                    mode="deterministic",
                    constraints=[Constraint(argumentName="amount", enabled=True, maximum=1000)],
                )
            )
            updated = await admin.updatePolicy(
                "transfer_funds",
                UpdatePolicyInput(
                    mode="llm",
                    llmConfig=LlmConfig(description="review", exceptions=["safe"]),
                ),
            )
            deleted = await admin.deletePolicy("transfer_funds")
            activated = await admin.activatePolicy("transfer_funds")
            deactivated = await admin.deactivatePolicy("transfer_funds")
            exported = await admin.exportPolicies({"projectId": "proj_1", "format": "yaml"})
            snake_exported = await admin.export_policies({"projectId": "proj_1"})
            await admin.close()

        assert policies[0]._id == "pol_1"
        assert policy.toolName == "transfer_funds"
        assert created._id == "pol_created"
        assert updated.mode == "llm"
        assert deleted is None
        assert activated is None
        assert deactivated is None
        assert exported == "policies: []"
        assert snake_exported == "policies: []"
        assert server.requests[0]["path_qs"] == "/v1/policies?projectId=proj_1"
        assert server.requests[7]["path_qs"] == "/v1/policies/export?projectId=proj_1&format=yaml"
        assert server.requests[0]["headers"]["X-Veto-API-Key"] == "test-key"

    async def test_decisions_methods(self) -> None:
        async def list_decisions(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(
                {
                    "data": [
                        {
                            "_id": "dec_1",
                            "toolName": "transfer_funds",
                            "arguments": {"amount": 200},
                            "decision": "allow",
                            "mode": "deterministic",
                            "latencyMs": 12,
                            "createdAt": "2026-01-01T00:00:00.000Z",
                        }
                    ],
                    "pagination": {"total": 1, "limit": 50, "offset": 10, "hasMore": False},
                }
            )

        async def get_decision(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(
                {
                    "_id": "dec_1",
                    "toolName": "transfer_funds",
                    "arguments": {"amount": 200},
                    "decision": "allow",
                    "mode": "deterministic",
                    "latencyMs": 12,
                    "createdAt": "2026-01-01T00:00:00.000Z",
                }
            )

        async def stats(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"total": 10, "allowed": 8, "denied": 1, "requireApproval": 1})

        async def export_decisions(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(text="tool,decision\ntransfer_funds,allow\n", content_type="text/csv")

        routes = [
            ("GET", "/v1/decisions", list_decisions),
            ("GET", "/v1/decisions/dec_1", get_decision),
            ("GET", "/v1/decisions/stats", stats),
            ("GET", "/v1/decisions/export", export_decisions),
        ]

        async with run_test_server(routes) as server:
            admin = make_admin(server.base_url)
            result = await admin.listDecisions(
                DecisionQuery(
                    limit=50,
                    offset=10,
                    projectId="proj_1",
                    toolName="transfer_funds",
                    decision="allow",
                    startDate="2026-01-01",
                    endDate="2026-01-31",
                )
            )
            decision = await admin.getDecision("dec_1")
            stats_result = await admin.getDecisionStats(
                {"projectId": "proj_1", "startDate": "2026-01-01", "endDate": "2026-01-31"}
            )
            exported = await admin.exportDecisions({"projectId": "proj_1", "format": "csv"})
            snake_result = await admin.list_decisions({"toolName": "transfer_funds"})
            await admin.close()

        assert result.data[0]._id == "dec_1"
        assert result.pagination.offset == 10
        assert decision.decision == "allow"
        assert stats_result.requireApproval == 1
        assert exported.startswith("tool,decision")
        assert snake_result.data[0].toolName == "transfer_funds"
        assert "toolName=transfer_funds" in server.requests[0]["path_qs"]
        assert "decision=allow" in server.requests[0]["path_qs"]
        assert server.requests[3]["path_qs"] == "/v1/decisions/export?projectId=proj_1&format=csv"

    async def test_approvals_methods(self) -> None:
        approval_payload = {
            "_id": "apr_1",
            "toolName": "transfer_funds",
            "arguments": {"amount": 200},
            "status": "pending",
            "expiresAt": "2026-01-01T01:00:00.000Z",
            "createdAt": "2026-01-01T00:00:00.000Z",
        }

        async def list_approvals(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [approval_payload]})

        async def get_approval(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(approval_payload)

        async def resolve_approval(_request: web.Request, body: Any) -> web.Response:
            assert body == {"action": "approve", "resolvedBy": "user@corp.com"}
            return web.json_response({**approval_payload, "status": "approved", "resolvedBy": "user@corp.com"})

        async def batch_resolve(_request: web.Request, body: Any) -> web.Response:
            assert body == {
                "approvals": [
                    {"id": "apr_1", "action": "approve", "resolvedBy": "user@corp.com"},
                    {"id": "apr_2", "action": "deny", "resolvedBy": "user@corp.com"},
                ]
            }
            return web.json_response(
                {"data": [{"id": "apr_1", "status": "approved"}, {"id": "apr_2", "status": "denied"}]}
            )

        routes = [
            ("GET", "/v1/approvals", list_approvals),
            ("GET", "/v1/approvals/pending", list_approvals),
            ("GET", "/v1/approvals/apr_1", get_approval),
            ("POST", "/v1/approvals/apr_1/resolve", resolve_approval),
            ("POST", "/v1/approvals/batch-resolve", batch_resolve),
        ]

        async with run_test_server(routes) as server:
            admin = make_admin(server.base_url)
            approvals = await admin.listApprovals({"status": "pending"})
            pending = await admin.listPendingApprovals()
            approval = await admin.getApproval("apr_1")
            resolved = await admin.resolveApproval("apr_1", "approve", "user@corp.com")
            batched = await admin.batchResolveApprovals(
                [
                    BatchResolveApprovalItem(id="apr_1", action="approve", resolvedBy="user@corp.com"),
                    {"id": "apr_2", "action": "deny", "resolvedBy": "user@corp.com"},
                ]
            )
            await admin.close()

        assert approvals[0]._id == "apr_1"
        assert pending[0].status == "pending"
        assert approval.toolName == "transfer_funds"
        assert resolved.status == "approved"
        assert batched.data[1].status == "denied"
        assert server.requests[0]["path_qs"] == "/v1/approvals?status=pending"

    async def test_tools_policy_drafts_and_upstreams_methods(self) -> None:
        async def list_tools(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [{"_id": "tool_1", "name": "transfer_funds", "arguments": []}]})

        async def no_content(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(status=204)

        async def list_drafts(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(
                {"data": [{"_id": "draft_1", "name": "Draft", "status": "draft", "rules": [], "createdAt": "2026-01-01T00:00:00.000Z"}]}
            )

        async def create_draft(_request: web.Request, body: Any) -> web.Response:
            assert body == {
                "name": "Draft",
                "description": "desc",
                "rules": [{"foo": "bar"}],
                "projectId": "proj_1",
                "status": "draft",
                "createdByAgentId": "agent_1",
            }
            return web.json_response(
                {"_id": "draft_1", "name": "Draft", "status": "draft", "rules": [{"foo": "bar"}], "createdAt": "2026-01-01T00:00:00.000Z"},
                status=201,
            )

        async def get_draft(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"_id": "draft_1", "name": "Draft", "status": "draft", "rules": [], "createdAt": "2026-01-01T00:00:00.000Z"})

        async def reject_draft(_request: web.Request, body: Any) -> web.Response:
            assert body == {"reason": "needs work"}
            return web.json_response({"_id": "draft_1", "name": "Draft", "status": "rejected", "rules": [], "createdAt": "2026-01-01T00:00:00.000Z"})

        async def approve_draft(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"_id": "draft_1", "name": "Draft", "status": "approved", "rules": [], "createdAt": "2026-01-01T00:00:00.000Z"})

        async def list_upstreams(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [{"_id": "up_1", "slug": "local", "name": "Local", "transport": "mcp-sse", "enabled": True}]})

        async def create_upstream(_request: web.Request, body: Any) -> web.Response:
            assert body == {
                "name": "Local",
                "transport": "mcp-sse",
                "url": "http://localhost:3001/mcp",
                "args": ["--verbose"],
                "headers": {"X-Test": "1"},
                "timeoutMs": 5000,
                "enabled": True,
                "projectId": "proj_1",
            }
            return web.json_response({"_id": "up_1", "slug": "local", "name": "Local", "transport": "mcp-sse", "enabled": True}, status=201)

        async def test_upstream(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"status": "ok", "latencyMs": 15})

        routes = [
            ("GET", "/v1/tools", list_tools),
            ("DELETE", "/v1/tools/transfer_funds", no_content),
            ("GET", "/v1/policy-drafts", list_drafts),
            ("POST", "/v1/policy-drafts", create_draft),
            ("GET", "/v1/policy-drafts/draft_1", get_draft),
            ("POST", "/v1/policy-drafts/draft_1/approve", approve_draft),
            ("POST", "/v1/policy-drafts/draft_1/reject", reject_draft),
            ("GET", "/v1/mcp/upstreams", list_upstreams),
            ("POST", "/v1/mcp/upstreams", create_upstream),
            ("DELETE", "/v1/mcp/upstreams/up_1", no_content),
            ("POST", "/v1/mcp/upstreams/up_1/test", test_upstream),
        ]

        async with run_test_server(routes) as server:
            admin = make_admin(server.base_url)
            tools = await admin.listTools()
            deleted_tool = await admin.deleteTool("transfer_funds")
            drafts = await admin.listPolicyDrafts({"status": "draft", "projectId": "proj_1"})
            created_draft = await admin.createPolicyDraft(
                CreatePolicyDraftInput(
                    name="Draft",
                    description="desc",
                    rules=[{"foo": "bar"}],
                    projectId="proj_1",
                    status="draft",
                    createdByAgentId="agent_1",
                )
            )
            fetched_draft = await admin.getPolicyDraft("draft_1")
            approved_draft = await admin.approvePolicyDraft("draft_1")
            rejected_draft = await admin.rejectPolicyDraft("draft_1", "needs work")
            upstreams = await admin.listUpstreams()
            created_upstream = await admin.createUpstream(
                CreateUpstreamInput(
                    name="Local",
                    transport="mcp-sse",
                    url="http://localhost:3001/mcp",
                    args=["--verbose"],
                    headers={"X-Test": "1"},
                    timeoutMs=5000,
                    enabled=True,
                    projectId="proj_1",
                )
            )
            deleted_upstream = await admin.deleteUpstream("up_1")
            upstream_test = await admin.testUpstream("up_1")
            await admin.close()

        assert tools[0]._id == "tool_1"
        assert deleted_tool is None
        assert drafts[0]._id == "draft_1"
        assert created_draft._id == "draft_1"
        assert fetched_draft.name == "Draft"
        assert approved_draft.status == "approved"
        assert rejected_draft.status == "rejected"
        assert upstreams[0]._id == "up_1"
        assert created_upstream.slug == "local"
        assert deleted_upstream is None
        assert upstream_test.status == "ok"
        assert server.requests[2]["path_qs"] == "/v1/policy-drafts?status=draft&projectId=proj_1"

    async def test_api_keys_organizations_and_projects_methods(self) -> None:
        async def list_keys(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response(
                {"data": [{"_id": "key_1", "name": "Prod", "keyPrefix": "veto_live", "isRevoked": False, "projectId": "proj_1", "createdAt": "2026-01-01T00:00:00.000Z"}]}
            )

        async def create_key(_request: web.Request, body: Any) -> web.Response:
            assert body == {"name": "Prod", "projectId": "proj_1"}
            return web.json_response({"id": "key_1", "name": "Prod", "key": "secret", "keyPrefix": "veto_live"}, status=201)

        async def no_content(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(status=204)

        async def list_orgs(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [{"_id": "org_1", "name": "Acme", "slug": "acme"}]})

        async def list_projects(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [{"_id": "proj_1", "organizationId": "org_1", "name": "Core", "isDefault": True}]})

        routes = [
            ("GET", "/v1/api-keys", list_keys),
            ("POST", "/v1/api-keys", create_key),
            ("DELETE", "/v1/api-keys/key_1", no_content),
            ("GET", "/v1/organizations", list_orgs),
            ("GET", "/v1/projects", list_projects),
        ]

        async with run_test_server(routes) as server:
            admin = make_admin(server.base_url)
            keys = await admin.listApiKeys()
            created_key = await admin.createApiKey({"name": "Prod", "projectId": "proj_1", "unused": None})
            revoked = await admin.revokeApiKey("key_1")
            orgs = await admin.listOrganizations()
            projects = await admin.listProjects({"organizationId": "org_1"})
            snake_orgs = await admin.list_organizations()
            snake_projects = await admin.list_projects({"organizationId": "org_1"})
            await admin.close()

        assert keys[0]._id == "key_1"
        assert created_key._id == "key_1"
        assert revoked is None
        assert orgs.data[0]._id == "org_1"
        assert projects.data[0]._id == "proj_1"
        assert snake_orgs.data[0].slug == "acme"
        assert snake_projects.data[0].organizationId == "org_1"
        assert server.requests[4]["path_qs"] == "/v1/projects?organizationId=org_1"

    async def test_python_helper_signatures(self) -> None:
        async def create_org(_request: web.Request, body: Any) -> web.Response:
            assert body == {"name": "Acme AI", "slug": "acme-ai"}
            return web.json_response({"_id": "org_1", "name": "Acme AI", "slug": "acme-ai"}, status=201)

        async def create_project(_request: web.Request, body: Any) -> web.Response:
            assert body == {"organizationId": "org_1", "name": "Core"}
            return web.json_response(
                {"_id": "proj_1", "organizationId": "org_1", "name": "Core", "isDefault": True, "apiKey": "secret"},
                status=201,
            )

        async def create_key(_request: web.Request, body: Any) -> web.Response:
            assert body == {"projectId": "proj_1", "name": "Prod"}
            return web.json_response({"id": "key_1", "name": "Prod", "key": "secret", "keyPrefix": "veto_live"}, status=201)

        async def list_orgs(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [{"_id": "org_1", "name": "Acme AI", "slug": "acme-ai"}]})

        async def list_projects(_request: web.Request, _body: Any) -> web.Response:
            return web.json_response({"data": [{"_id": "proj_1", "organizationId": "org_1", "name": "Core", "isDefault": True}]})

        routes = [
            ("POST", "/v1/organizations", create_org),
            ("POST", "/v1/projects", create_project),
            ("POST", "/v1/api-keys", create_key),
            ("GET", "/v1/organizations", list_orgs),
            ("GET", "/v1/projects", list_projects),
        ]

        async with run_test_server(routes) as server:
            admin = make_admin(server.base_url)
            org = await admin.create_organization("Acme AI")
            project = await admin.create_project("org_1", "Core")
            key = await admin.create_api_key("proj_1", "Prod")
            orgs = await admin.list_organizations()
            projects = await admin.list_projects("org_1")
            projects_no_filter = await admin.list_projects()
            await admin.close()

        assert org._id == "org_1"
        assert project.apiKey == "secret"
        assert key._id == "key_1"
        assert orgs.data[0].slug == "acme-ai"
        assert projects.data[0]._id == "proj_1"
        assert projects_no_filter.data[0].name == "Core"
        assert server.requests[4]["path_qs"] == "/v1/projects?organizationId=org_1"
        assert server.requests[5]["path_qs"] == "/v1/projects"

    async def test_error_timeout_and_empty_body_handling(self) -> None:
        async def error_route(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(status=418, text="teapot")

        async def timeout_route(_request: web.Request, _body: Any) -> web.Response:
            await asyncio.sleep(0.05)
            return web.json_response({"data": []})

        async def empty_route(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(status=200, body=b"")

        async with run_test_server([("GET", "/v1/tools", error_route)]) as server:
            admin = make_admin(server.base_url)
            with pytest.raises(VetoAdminError, match=r"GET /tools failed \(418\): teapot") as exc:
                await admin.listTools()
            await admin.close()
        assert exc.value.statusCode == 418
        assert exc.value.status_code == 418

        async with run_test_server([("GET", "/v1/tools", timeout_route)]) as server:
            admin = make_admin(server.base_url, timeout=10)
            with pytest.raises(VetoAdminError, match="Request timed out after 10ms") as exc:
                await admin.listTools()
            await admin.close()
        assert exc.value.statusCode == 0

        async with run_test_server([("DELETE", "/v1/tools/transfer_funds", empty_route)]) as server:
            admin = make_admin(server.base_url)
            result = await admin.deleteTool("transfer_funds")
            await admin.close()
        assert result is None

    async def test_on_event_callback_subscription(self) -> None:
        async def events(_request: web.Request, _body: Any) -> web.StreamResponse:
            response = web.StreamResponse(status=200, headers={"Content-Type": "text/event-stream"})
            await response.prepare(_request)
            for chunk in [
                "data: :ping\n",
                'data: {"type":"decision.created","data":{"id":"dec_1"}}\n',
                "data: not-json\n",
                'data: {"type":"approval.pending","data":{"id":"apr_1"}}\n',
            ]:
                await response.write(chunk.encode())
                await asyncio.sleep(0.01)
            await response.write_eof()
            return response

        async with run_test_server([("GET", "/v1/events/stream", events)]) as server:
            admin = make_admin(server.base_url)
            seen: list[VetoAdminEvent] = []
            subscription = admin.onEvent(["decision.created", "approval.pending"], seen.append)
            await asyncio.sleep(0.08)
            subscription.unsubscribe()
            await asyncio.sleep(0)
            await admin.close()

        assert len(seen) == 2
        assert seen[0].type == "decision.created"
        assert seen[1].data["id"] == "apr_1"
        assert server.requests[0]["query"] == {"types": "decision.created,approval.pending"}
        assert server.requests[0]["headers"]["Accept"] == "text/event-stream"

    async def test_subscribe_events_async_iterator_and_errors(self) -> None:
        async def events(_request: web.Request, _body: Any) -> web.StreamResponse:
            response = web.StreamResponse(status=200, headers={"Content-Type": "text/event-stream"})
            await response.prepare(_request)
            await response.write(b'data: :ping\n')
            await response.write(b'data: {"type":"tool.deleted","data":{"name":"transfer_funds"}}\n')
            await response.write(b'data: malformed\n')
            await response.write(b'data: {"type":"policy.updated","data":{"id":"pol_1"}}\n')
            await response.write_eof()
            return response

        async with run_test_server([("GET", "/v1/events/stream", events)]) as server:
            admin = make_admin(server.base_url)
            seen = [event async for event in admin.subscribeEvents({"types": ["tool.deleted", "policy.updated"]})]
            await admin.close()

        assert [event.type for event in seen] == ["tool.deleted", "policy.updated"]
        assert server.requests[0]["query"] == {"types": "tool.deleted,policy.updated"}

        async def sse_error(_request: web.Request, _body: Any) -> web.Response:
            return web.Response(status=503, text="down")

        async with run_test_server([("GET", "/v1/events/stream", sse_error)]) as server:
            admin = make_admin(server.base_url)
            with pytest.raises(VetoAdminError, match="SSE connection failed: 503"):
                async for _event in admin.subscribeEvents():
                    pass
            await admin.close()
