from __future__ import annotations

import asyncio
import json
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncGenerator,
    Callable,
    ClassVar,
    Generic,
    Literal,
    Optional,
    TypeVar,
)
from urllib.parse import quote, urlencode

import aiohttp

if TYPE_CHECKING:
    BaseModelType = TypeVar("BaseModelType", bound="BaseModel")

    class BaseModel:
        model_config: ClassVar[object]

        def __init__(self, **data: Any) -> None: ...

        @classmethod
        def model_validate(cls: type[BaseModelType], obj: object) -> BaseModelType: ...

        def model_dump(
            self,
            *,
            by_alias: bool = False,
            exclude_none: bool = False,
        ) -> dict[str, Any]: ...

    class AliasChoices:
        def __init__(self, *choices: str) -> None: ...

    class ConfigDict(dict[str, object]):
        pass

    def Field(*args: Any, **kwargs: Any) -> Any: ...
else:
    from pydantic import AliasChoices, BaseModel, ConfigDict, Field

DEFAULT_BASE_URL = "https://api.veto.so"
DEFAULT_TIMEOUT = 30_000

JsonDict = dict[str, Any]
T = TypeVar("T")
ModelType = TypeVar("ModelType", bound="AdminModel")


class VetoAdminError(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.statusCode = status_code

    @property
    def status_code(self) -> int:
        return self.statusCode


class AdminModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class IdModel(AdminModel):
    id: str = Field(validation_alias=AliasChoices("_id", "id"), serialization_alias="_id")

    @property
    def _id(self) -> str:
        return self.id


class VetoAdminOptions(AdminModel):
    apiKey: str
    baseUrl: str = DEFAULT_BASE_URL
    timeout: int = DEFAULT_TIMEOUT


class Constraint(AdminModel):
    argumentName: str
    enabled: bool
    action: Optional[Literal["deny", "require_approval"]] = None
    greaterThan: Optional[float] = None
    lessThan: Optional[float] = None
    greaterThanOrEqual: Optional[float] = None
    lessThanOrEqual: Optional[float] = None
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    minLength: Optional[int] = None
    maxLength: Optional[int] = None
    regex: Optional[str] = None
    notRegex: Optional[str] = None
    enum: Optional[list[str]] = None
    notEnum: Optional[list[str]] = None
    required: Optional[bool] = None
    notNull: Optional[bool] = None
    dynamicMinimum: Optional[str] = None
    dynamicMaximum: Optional[str] = None


class OutputCondition(AdminModel):
    field: str
    operator: str
    value: Any


class OutputRule(AdminModel):
    id: str
    name: str
    action: Literal["block", "redact", "log"]
    tools: Optional[list[str]] = None
    output_conditions: Optional[list[OutputCondition]] = None
    unless: Optional[list[OutputCondition]] = None
    redact_with: Optional[str] = None


class ArgumentInstruction(AdminModel):
    argumentName: str
    instruction: str


class LlmConfig(AdminModel):
    description: str
    exceptions: list[str]
    argumentInstructions: Optional[list[ArgumentInstruction]] = None
    preferredModel: Optional[str] = None


class CumulativeLimit(AdminModel):
    argumentName: str
    maxValue: float


class SessionCounter(AdminModel):
    increment: list[str]
    decrement: Optional[list[str]] = None
    max: Optional[int] = None
    maxAction: Optional[Literal["deny", "require_approval"]] = None


class SessionConstraints(AdminModel):
    maxCalls: Optional[int] = None
    spendArgument: Optional[str] = None
    budget: Optional[float] = None
    cumulativeLimits: Optional[list[CumulativeLimit]] = None
    counters: Optional[dict[str, SessionCounter]] = None


class Policy(IdModel):
    toolName: str
    mode: Literal["deterministic", "llm"]
    version: int
    isActive: bool
    constraints: Optional[list[Constraint]] = None
    outputRules: Optional[list[OutputRule]] = None
    llmConfig: Optional[LlmConfig] = None
    sessionConstraints: Optional[SessionConstraints] = None
    projectId: Optional[str] = None
    createdAt: str


class CreatePolicyInput(AdminModel):
    toolName: str
    projectId: Optional[str] = None
    mode: Literal["deterministic", "llm"]
    constraints: Optional[list[Constraint]] = None
    outputRules: Optional[list[OutputRule]] = None
    llmConfig: Optional[LlmConfig] = None
    sessionConstraints: Optional[SessionConstraints] = None


class UpdatePolicyInput(AdminModel):
    mode: Literal["deterministic", "llm"]
    constraints: Optional[list[Constraint]] = None
    outputRules: Optional[list[OutputRule]] = None
    llmConfig: Optional[LlmConfig] = None
    sessionConstraints: Optional[SessionConstraints] = None


class Decision(IdModel):
    toolName: str
    arguments: JsonDict
    decision: Literal["allow", "deny", "require_approval"]
    mode: str
    reason: Optional[str] = None
    latencyMs: float
    createdAt: str


class DecisionQuery(AdminModel):
    limit: Optional[int] = None
    offset: Optional[int] = None
    projectId: Optional[str] = None
    toolName: Optional[str] = None
    decision: Optional[Literal["allow", "deny", "require_approval"]] = None
    startDate: Optional[str] = None
    endDate: Optional[str] = None


class DecisionStats(AdminModel):
    total: int
    allowed: int
    denied: int
    requireApproval: int


class Pagination(AdminModel):
    total: int
    limit: int
    offset: int
    hasMore: bool


class PaginatedResult(AdminModel, Generic[T]):
    data: list[T]
    pagination: Pagination


class Approval(IdModel):
    toolName: str
    arguments: Optional[JsonDict] = None
    status: Literal["pending", "approved", "denied", "expired"]
    expiresAt: str
    resolvedBy: Optional[str] = None
    resolvedAt: Optional[str] = None
    createdAt: str


class Tool(IdModel):
    name: str
    description: Optional[str] = None
    arguments: list[JsonDict]


class PolicyDraft(IdModel):
    name: str
    description: Optional[str] = None
    status: Literal["draft", "pending_review", "approved", "rejected"]
    createdByAgentId: Optional[str] = None
    rules: list[JsonDict]
    createdAt: str


class CreatePolicyDraftInput(AdminModel):
    name: str
    description: Optional[str] = None
    rules: list[JsonDict]
    projectId: Optional[str] = None
    status: Optional[Literal["draft", "pending_review"]] = None
    createdByAgentId: Optional[str] = None


class McpUpstream(IdModel):
    slug: str
    name: str
    transport: Literal["mcp-sse", "mcp-stdio"]
    url: Optional[str] = None
    command: Optional[str] = None
    enabled: bool


class CreateUpstreamInput(AdminModel):
    name: str
    transport: Literal["mcp-sse", "mcp-stdio"]
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[list[str]] = None
    headers: Optional[dict[str, str]] = None
    timeoutMs: Optional[int] = None
    enabled: Optional[bool] = None
    projectId: Optional[str] = None


class UpstreamTestResult(AdminModel):
    status: Literal["ok", "error"]
    latencyMs: Optional[float] = None
    error: Optional[str] = None


class ApiKeyInfo(IdModel):
    name: str
    keyPrefix: str
    isRevoked: bool
    projectId: Optional[str] = None
    lastUsedAt: Optional[str] = None
    createdAt: str


class ApiKeyCreated(IdModel):
    name: str
    key: str
    keyPrefix: str


class VetoAdminEvent(AdminModel):
    type: str
    data: JsonDict


class OrganizationSettingsRateLimit(AdminModel):
    windowMs: Optional[int] = None
    maxRequests: Optional[int] = None


class OrganizationSettings(AdminModel):
    requireApprovalTimeout: Optional[int] = None
    webhookUrl: Optional[str] = None
    slackWebhookUrl: Optional[str] = None
    decisionWebhookUrl: Optional[str] = None
    rateLimit: Optional[OrganizationSettingsRateLimit] = None


class Organization(IdModel):
    name: str
    slug: str
    ownerId: Optional[str] = None
    tier: Optional[str] = None
    billingPeriodStart: Optional[str] = None
    settings: Optional[OrganizationSettings] = None
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


class Project(IdModel):
    organizationId: str
    name: str
    isDefault: bool
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


class ProjectCreated(Project):
    apiKey: str


class ListResponse(AdminModel, Generic[T]):
    data: list[T]


class ResolveApprovalInput(AdminModel):
    action: Literal["approve", "deny"]
    resolvedBy: str


class BatchResolveApprovalItem(AdminModel):
    id: str
    action: Literal["approve", "deny"]
    resolvedBy: str


class BatchResolveApprovalResult(AdminModel):
    id: str
    status: str
    action: Optional[str] = None
    error: Optional[str] = None


class BatchResolveApprovalsResponse(AdminModel):
    data: list[BatchResolveApprovalResult]


class EventSubscription:
    def __init__(self, task: asyncio.Task[None]):
        self._task = task

    def unsubscribe(self) -> None:
        self._task.cancel()


class VetoAdmin:
    def __init__(
        self,
        options: VetoAdminOptions | dict[str, Any] | None = None,
        *,
        apiKey: Optional[str] = None,
        baseUrl: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
        payload: dict[str, Any]
        if options is not None:
            payload = options.model_dump(by_alias=True) if isinstance(options, VetoAdminOptions) else dict(options)
        else:
            payload = {}
            if apiKey is not None:
                payload["apiKey"] = apiKey
            if baseUrl is not None:
                payload["baseUrl"] = baseUrl
            if timeout is not None:
                payload["timeout"] = timeout
        if not payload.get("apiKey"):
            raise ValueError("VetoAdmin requires an apiKey")
        parsed = VetoAdminOptions.model_validate(payload)
        self.apiKey = parsed.apiKey
        self.baseUrl = parsed.baseUrl.rstrip("/")
        self.timeout = parsed.timeout
        self._session: Optional[aiohttp.ClientSession] = None

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    async def __aenter__(self) -> VetoAdmin:
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.close()

    async def _request_model(
        self,
        model: type[ModelType],
        method: str,
        path: str,
        *,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> ModelType:
        response = await self._request(method, path, params=params, body=body)
        if response is None:
            raise VetoAdminError(f"{method} {path} returned no body", 0)
        return model.model_validate(response)

    async def listPolicies(self, opts: Optional[dict[str, str]] = None) -> list[Policy]:
        params = _compact_query(opts)
        response = await self._request("GET", "/policies", params=params)
        return ListResponse[Policy].model_validate(response).data

    async def getPolicy(self, toolName: str) -> Policy:
        return Policy.model_validate(await self._request("GET", f"/policies/{_enc(toolName)}"))

    async def createPolicy(self, input: CreatePolicyInput | dict[str, Any]) -> Policy:
        payload = CreatePolicyInput.model_validate(input).model_dump(exclude_none=True)
        return Policy.model_validate(await self._request("POST", "/policies", body=payload))

    async def updatePolicy(self, toolName: str, input: UpdatePolicyInput | dict[str, Any]) -> Policy:
        payload = UpdatePolicyInput.model_validate(input).model_dump(exclude_none=True)
        return Policy.model_validate(
            await self._request("PUT", f"/policies/{_enc(toolName)}", body=payload)
        )

    async def deletePolicy(self, toolName: str) -> None:
        await self._request("DELETE", f"/policies/{_enc(toolName)}")
        return None

    async def activatePolicy(self, toolName: str) -> None:
        await self._request("POST", f"/policies/{_enc(toolName)}/activate")
        return None

    async def deactivatePolicy(self, toolName: str) -> None:
        await self._request("POST", f"/policies/{_enc(toolName)}/deactivate")
        return None

    async def exportPolicies(self, opts: Optional[dict[str, str]] = None) -> str:
        return await self._raw_request("GET", "/policies/export", params=_compact_query(opts))

    async def listDecisions(
        self, query: DecisionQuery | dict[str, Any] | None = None
    ) -> PaginatedResult[Decision]:
        params = _compact_query(
            DecisionQuery.model_validate(query).model_dump(exclude_none=True) if query is not None else None
        )
        response = await self._request("GET", "/decisions", params=params)
        return PaginatedResult[Decision].model_validate(response)

    async def getDecision(self, id: str) -> Decision:
        return Decision.model_validate(await self._request("GET", f"/decisions/{_enc(id)}"))

    async def getDecisionStats(self, opts: Optional[dict[str, Any]] = None) -> DecisionStats:
        return DecisionStats.model_validate(
            await self._request("GET", "/decisions/stats", params=_compact_query(opts))
        )

    async def exportDecisions(self, opts: Optional[dict[str, Any]] = None) -> str:
        return await self._raw_request("GET", "/decisions/export", params=_compact_query(opts))

    async def listApprovals(self, opts: Optional[dict[str, str]] = None) -> list[Approval]:
        response = await self._request("GET", "/approvals", params=_compact_query(opts))
        return ListResponse[Approval].model_validate(response).data

    async def listPendingApprovals(self) -> list[Approval]:
        response = await self._request("GET", "/approvals/pending")
        return ListResponse[Approval].model_validate(response).data

    async def getApproval(self, id: str) -> Approval:
        return Approval.model_validate(await self._request("GET", f"/approvals/{_enc(id)}"))

    async def resolveApproval(
        self, id: str, action: Literal["approve", "deny"], resolvedBy: str
    ) -> Approval:
        payload = ResolveApprovalInput(action=action, resolvedBy=resolvedBy).model_dump()
        return Approval.model_validate(
            await self._request("POST", f"/approvals/{_enc(id)}/resolve", body=payload)
        )

    async def batchResolveApprovals(
        self, approvals: list[BatchResolveApprovalItem | dict[str, Any]]
    ) -> BatchResolveApprovalsResponse:
        payload = {
            "approvals": [
                BatchResolveApprovalItem.model_validate(item).model_dump() for item in approvals
            ]
        }
        return BatchResolveApprovalsResponse.model_validate(
            await self._request("POST", "/approvals/batch-resolve", body=payload)
        )

    async def listTools(self) -> list[Tool]:
        response = await self._request("GET", "/tools")
        return ListResponse[Tool].model_validate(response).data

    async def deleteTool(self, name: str) -> None:
        await self._request("DELETE", f"/tools/{_enc(name)}")
        return None

    async def listPolicyDrafts(self, opts: Optional[dict[str, str]] = None) -> list[PolicyDraft]:
        response = await self._request("GET", "/policy-drafts", params=_compact_query(opts))
        return ListResponse[PolicyDraft].model_validate(response).data

    async def createPolicyDraft(self, input: CreatePolicyDraftInput | dict[str, Any]) -> PolicyDraft:
        payload = CreatePolicyDraftInput.model_validate(input).model_dump(exclude_none=True)
        return PolicyDraft.model_validate(await self._request("POST", "/policy-drafts", body=payload))

    async def getPolicyDraft(self, id: str) -> PolicyDraft:
        return PolicyDraft.model_validate(await self._request("GET", f"/policy-drafts/{_enc(id)}"))

    async def approvePolicyDraft(self, id: str) -> PolicyDraft:
        return PolicyDraft.model_validate(
            await self._request("POST", f"/policy-drafts/{_enc(id)}/approve")
        )

    async def rejectPolicyDraft(self, id: str, reason: Optional[str] = None) -> PolicyDraft:
        body = {"reason": reason} if reason is not None else None
        return PolicyDraft.model_validate(
            await self._request("POST", f"/policy-drafts/{_enc(id)}/reject", body=body)
        )

    async def listUpstreams(self) -> list[McpUpstream]:
        response = await self._request("GET", "/mcp/upstreams")
        return ListResponse[McpUpstream].model_validate(response).data

    async def createUpstream(self, input: CreateUpstreamInput | dict[str, Any]) -> McpUpstream:
        payload = CreateUpstreamInput.model_validate(input).model_dump(exclude_none=True)
        return McpUpstream.model_validate(
            await self._request("POST", "/mcp/upstreams", body=payload)
        )

    async def deleteUpstream(self, id: str) -> None:
        await self._request("DELETE", f"/mcp/upstreams/{_enc(id)}")
        return None

    async def testUpstream(self, id: str) -> UpstreamTestResult:
        return UpstreamTestResult.model_validate(
            await self._request("POST", f"/mcp/upstreams/{_enc(id)}/test")
        )

    async def listApiKeys(self) -> list[ApiKeyInfo]:
        response = await self._request("GET", "/api-keys")
        return ListResponse[ApiKeyInfo].model_validate(response).data

    async def createApiKey(self, input: dict[str, Any]) -> ApiKeyCreated:
        payload = _compact_dict(input)
        return ApiKeyCreated.model_validate(await self._request("POST", "/api-keys", body=payload))

    async def revokeApiKey(self, id: str) -> None:
        await self._request("DELETE", f"/api-keys/{_enc(id)}")
        return None

    async def listOrganizations(self) -> ListResponse[Organization]:
        return ListResponse[Organization].model_validate(await self._request("GET", "/organizations"))

    async def listProjects(self, opts: Optional[dict[str, str]] = None) -> ListResponse[Project]:
        return ListResponse[Project].model_validate(
            await self._request("GET", "/projects", params=_compact_query(opts))
        )

    async def create_organization(self, name: str) -> Organization:
        payload = {"name": name, "slug": _slugify(name)}
        return Organization.model_validate(await self._request("POST", "/organizations", body=payload))

    async def create_project(self, org_id: str, name: str) -> ProjectCreated:
        payload = {"organizationId": org_id, "name": name}
        return ProjectCreated.model_validate(await self._request("POST", "/projects", body=payload))

    async def create_api_key(self, project_id: str, name: str) -> ApiKeyCreated:
        return await self.createApiKey({"projectId": project_id, "name": name})

    async def list_organizations(self) -> ListResponse[Organization]:
        return await self.listOrganizations()

    async def list_projects(self, org_id: str | None = None) -> ListResponse[Project]:
        opts = {"organizationId": org_id} if org_id is not None else None
        return await self.listProjects(opts)

    def onEvent(
        self,
        type: str | list[str],
        callback: Callable[[VetoAdminEvent], None],
    ) -> EventSubscription:
        types = ",".join(type) if isinstance(type, list) else type

        async def run() -> None:
            params = {"types": types} if types else None
            url = self._build_url("/events/stream", params)
            session = self._get_session()
            try:
                async with session.get(
                    url,
                    headers={"Accept": "text/event-stream"},
                    timeout=None,
                ) as response:
                    if response.status >= 400 or response.content is None:
                        return
                    async for event in self._iter_sse(response):
                        callback(event)
            except (asyncio.CancelledError, aiohttp.ClientError, asyncio.TimeoutError):
                return

        return EventSubscription(asyncio.create_task(run()))

    async def subscribeEvents(
        self, opts: Optional[dict[str, list[str]]] = None
    ) -> AsyncGenerator[VetoAdminEvent, None]:
        params: Optional[dict[str, str]] = None
        if opts and opts.get("types"):
            params = {"types": ",".join(opts["types"])}
        url = self._build_url("/events/stream", params)
        session = self._get_session()
        try:
            async with session.get(
                url,
                headers={"Accept": "text/event-stream"},
                timeout=None,
            ) as response:
                if response.status >= 400:
                    raise VetoAdminError(f"SSE connection failed: {response.status}", response.status)
                if response.content is None:
                    raise VetoAdminError("No response body for SSE stream", 0)
                async for event in self._iter_sse(response):
                    yield event
        except asyncio.TimeoutError as error:
            raise VetoAdminError(f"Request timed out after {self.timeout}ms", 0) from error
        except aiohttp.ClientError as error:
            raise VetoAdminError(str(error), 0) from error

    async def list_policies(self, opts: Optional[dict[str, str]] = None) -> list[Policy]:
        return await self.listPolicies(opts)

    async def get_policy(self, tool_name: str) -> Policy:
        return await self.getPolicy(tool_name)

    async def create_policy(self, input: CreatePolicyInput | dict[str, Any]) -> Policy:
        return await self.createPolicy(input)

    async def update_policy(self, tool_name: str, input: UpdatePolicyInput | dict[str, Any]) -> Policy:
        return await self.updatePolicy(tool_name, input)

    async def delete_policy(self, tool_name: str) -> None:
        return await self.deletePolicy(tool_name)

    async def activate_policy(self, tool_name: str) -> None:
        return await self.activatePolicy(tool_name)

    async def deactivate_policy(self, tool_name: str) -> None:
        return await self.deactivatePolicy(tool_name)

    async def export_policies(self, opts: Optional[dict[str, str]] = None) -> str:
        return await self.exportPolicies(opts)

    async def list_decisions(
        self, query: DecisionQuery | dict[str, Any] | None = None
    ) -> PaginatedResult[Decision]:
        return await self.listDecisions(query)

    async def get_decision(self, id: str) -> Decision:
        return await self.getDecision(id)

    async def get_decision_stats(self, opts: Optional[dict[str, Any]] = None) -> DecisionStats:
        return await self.getDecisionStats(opts)

    async def export_decisions(self, opts: Optional[dict[str, Any]] = None) -> str:
        return await self.exportDecisions(opts)

    async def list_approvals(self, opts: Optional[dict[str, str]] = None) -> list[Approval]:
        return await self.listApprovals(opts)

    async def list_pending_approvals(self) -> list[Approval]:
        return await self.listPendingApprovals()

    async def get_approval(self, id: str) -> Approval:
        return await self.getApproval(id)

    async def resolve_approval(
        self, id: str, action: Literal["approve", "deny"], resolved_by: str
    ) -> Approval:
        return await self.resolveApproval(id, action, resolved_by)

    async def batch_resolve_approvals(
        self, approvals: list[BatchResolveApprovalItem | dict[str, Any]]
    ) -> BatchResolveApprovalsResponse:
        return await self.batchResolveApprovals(approvals)

    async def list_tools(self) -> list[Tool]:
        return await self.listTools()

    async def delete_tool(self, name: str) -> None:
        return await self.deleteTool(name)

    async def list_policy_drafts(self, opts: Optional[dict[str, str]] = None) -> list[PolicyDraft]:
        return await self.listPolicyDrafts(opts)

    async def create_policy_draft(self, input: CreatePolicyDraftInput | dict[str, Any]) -> PolicyDraft:
        return await self.createPolicyDraft(input)

    async def get_policy_draft(self, id: str) -> PolicyDraft:
        return await self.getPolicyDraft(id)

    async def approve_policy_draft(self, id: str) -> PolicyDraft:
        return await self.approvePolicyDraft(id)

    async def reject_policy_draft(self, id: str, reason: Optional[str] = None) -> PolicyDraft:
        return await self.rejectPolicyDraft(id, reason)

    async def list_upstreams(self) -> list[McpUpstream]:
        return await self.listUpstreams()

    async def create_upstream(self, input: CreateUpstreamInput | dict[str, Any]) -> McpUpstream:
        return await self.createUpstream(input)

    async def delete_upstream(self, id: str) -> None:
        return await self.deleteUpstream(id)

    async def test_upstream(self, id: str) -> UpstreamTestResult:
        return await self.testUpstream(id)

    async def list_api_keys(self) -> list[ApiKeyInfo]:
        return await self.listApiKeys()

    async def revoke_api_key(self, id: str) -> None:
        return await self.revokeApiKey(id)

    def on_event(self, type: str | list[str], callback: Callable[[VetoAdminEvent], None]) -> EventSubscription:
        return self.onEvent(type, callback)

    async def subscribe_events(
        self, opts: Optional[dict[str, list[str]]] = None
    ) -> AsyncGenerator[VetoAdminEvent, None]:
        async for event in self.subscribeEvents(opts):
            yield event

    def _get_headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-Veto-API-Key": self.apiKey,
        }

    def _build_url(self, path: str, params: Optional[dict[str, str]] = None) -> str:
        query = urlencode(params or {})
        return f"{self.baseUrl}/v1{path}{f'?{query}' if query else ''}"

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers=self._get_headers())
        return self._session

    async def _request(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, str]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> Any:
        url = self._build_url(path, params)
        session = self._get_session()
        try:
            async with session.request(
                method,
                url,
                json=body,
                timeout=aiohttp.ClientTimeout(total=self.timeout / 1000),
            ) as response:
                if response.status >= 400:
                    text = await response.text()
                    raise VetoAdminError(
                        f"{method} {path} failed ({response.status}): {text}",
                        response.status,
                    )
                if response.status == 204 or response.content_length == 0:
                    return None
                text = await response.text()
                if text == "":
                    return None
                return json.loads(text)
        except asyncio.TimeoutError as error:
            raise VetoAdminError(f"Request timed out after {self.timeout}ms", 0) from error
        except aiohttp.ClientError as error:
            raise VetoAdminError(str(error), 0) from error

    async def _raw_request(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, str]] = None,
    ) -> str:
        url = self._build_url(path, params)
        session = self._get_session()
        try:
            async with session.request(
                method,
                url,
                timeout=aiohttp.ClientTimeout(total=self.timeout / 1000),
            ) as response:
                text = await response.text()
                if response.status >= 400:
                    raise VetoAdminError(
                        f"{method} {path} failed ({response.status}): {text}",
                        response.status,
                    )
                return text
        except asyncio.TimeoutError as error:
            raise VetoAdminError(f"Request timed out after {self.timeout}ms", 0) from error
        except aiohttp.ClientError as error:
            raise VetoAdminError(str(error), 0) from error

    async def _iter_sse(self, response: aiohttp.ClientResponse) -> AsyncGenerator[VetoAdminEvent, None]:
        buffer = ""
        async for chunk in response.content.iter_chunked(1024):
            buffer += chunk.decode("utf-8")
            lines = buffer.split("\n")
            buffer = lines.pop() if lines else ""
            for line in lines:
                event = self._parse_sse_line(line)
                if event is not None:
                    yield event
        event = self._parse_sse_line(buffer)
        if event is not None:
            yield event

    def _parse_sse_line(self, line: str) -> Optional[VetoAdminEvent]:
        if not line.startswith("data: "):
            return None
        payload = line[6:].strip()
        if not payload or payload == ":ping":
            return None
        try:
            return VetoAdminEvent.model_validate(json.loads(payload))
        except json.JSONDecodeError:
            return None


def _enc(value: str) -> str:
    return quote(value, safe="")


def _compact_query(values: Optional[dict[str, Any]]) -> Optional[dict[str, str]]:
    if not values:
        return None
    return {key: str(value) for key, value in values.items() if value is not None}


def _compact_dict(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def _slugify(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    slug = "-".join(part for part in slug.split("-") if part)
    if not slug:
        raise ValueError("Organization name must contain at least one alphanumeric character")
    return slug[:100]


__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "VetoAdmin",
    "VetoAdminError",
    "VetoAdminOptions",
    "Constraint",
    "OutputCondition",
    "OutputRule",
    "LlmConfig",
    "ArgumentInstruction",
    "SessionCounter",
    "CumulativeLimit",
    "SessionConstraints",
    "Policy",
    "CreatePolicyInput",
    "UpdatePolicyInput",
    "Decision",
    "DecisionQuery",
    "DecisionStats",
    "Pagination",
    "PaginatedResult",
    "Approval",
    "Tool",
    "PolicyDraft",
    "CreatePolicyDraftInput",
    "McpUpstream",
    "CreateUpstreamInput",
    "UpstreamTestResult",
    "ApiKeyInfo",
    "ApiKeyCreated",
    "VetoAdminEvent",
    "EventSubscription",
    "Organization",
    "Project",
    "ProjectCreated",
    "BatchResolveApprovalItem",
    "BatchResolveApprovalResult",
    "BatchResolveApprovalsResponse",
]
