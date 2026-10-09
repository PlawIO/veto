"""
Veto Cloud API client.

Handles communication with the Veto Cloud API for:
- Tool registration (sends tool signatures for policy template generation)
- Tool call validation (validates tool calls against cloud-managed policies)
"""

from typing import Any, Optional, TYPE_CHECKING
from dataclasses import dataclass
import os
import time
import asyncio
from urllib.parse import quote

from veto.cloud.types import (
    ToolRegistration,
    ToolRegistrationResponse,
    ValidationResponse,
    FailedConstraint,
    CloudDenialDetails,
    ApprovalData,
    ApprovalPollOptions,
    RuntimeActionCreateRequest,
    RuntimeActionData,
)

if TYPE_CHECKING:
    import aiohttp

    from veto.utils.logger import Logger


# Default API base URL
DEFAULT_BASE_URL = "https://api.veto.so"


def _load_aiohttp() -> Any:
    try:
        import aiohttp
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "aiohttp is required for Veto Cloud requests. Install it with "
            "`pip install 'veto[cloud]'` or use `Veto.local(...)` for "
            "dependency-free local enforcement."
        ) from exc

    return aiohttp


def _bounded_int(value: str | int, name: str, minimum: int, maximum: int) -> str:
    raw = str(value).strip()
    if not raw.isdigit():
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    parsed = int(raw)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    return str(parsed)


@dataclass
class VetoCloudConfig:
    """Configuration for the Veto Cloud client."""

    api_key: Optional[str] = None
    base_url: str = DEFAULT_BASE_URL
    timeout: int = 30000  # 30 seconds in milliseconds
    retries: int = 2
    retry_delay: int = 1000  # 1 second in milliseconds


class VetoCloudClient:
    """
    Client for interacting with the Veto Cloud API.

    Handles:
    - Tool registration: Sends tool signatures to cloud for policy template generation
    - Validation: Validates tool calls against cloud-managed constraints

    Example:
        >>> config = VetoCloudConfig(api_key="your-api-key")
        >>> client = VetoCloudClient(config)
        >>> await client.register_tools([tool1, tool2])
        >>> result = await client.validate("payment_processor", {"amount": 500})
    """

    def __init__(
        self,
        config: Optional[VetoCloudConfig] = None,
        logger: Optional["Logger"] = None,
    ):
        self._config = config or VetoCloudConfig()
        self._logger = logger

        # Resolve API key from config or environment
        self._api_key = self._config.api_key or os.environ.get("VETO_API_KEY")

        # Ensure base URL doesn't have trailing slash
        self._base_url = self._config.base_url.rstrip("/")

        # Track registered tools to avoid duplicate registrations
        self._registered_tools: set[str] = set()

        # Shared session (lazy-initialized)
        self._session: Optional["aiohttp.ClientSession"] = None

    def _get_session(self) -> "aiohttp.ClientSession":
        aiohttp = _load_aiohttp()
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=self._config.timeout / 1000),
                headers=self._get_headers(),
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    def _log_debug(self, message: str, data: Optional[dict[str, Any]] = None) -> None:
        """Log debug message if logger available."""
        if self._logger:
            self._logger.debug(message, data)

    def _log_info(self, message: str, data: Optional[dict[str, Any]] = None) -> None:
        """Log info message if logger available."""
        if self._logger:
            self._logger.info(message, data)

    def _log_warn(self, message: str, data: Optional[dict[str, Any]] = None) -> None:
        """Log warning message if logger available."""
        if self._logger:
            self._logger.warn(message, data)

    def _log_error(
        self,
        message: str,
        data: Optional[dict[str, Any]] = None,
        error: Optional[Exception] = None,
    ) -> None:
        """Log error message if logger available."""
        if self._logger:
            self._logger.error(message, data, error)

    def _get_headers(self) -> dict[str, str]:
        """Get request headers including authentication."""
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["X-Veto-API-Key"] = self._api_key
        return headers

    async def register_tools(
        self, tools: list[ToolRegistration]
    ) -> ToolRegistrationResponse:
        """
        Register tools with the Veto Cloud API.

        This sends tool signatures to the cloud, which generates policy templates
        that users can then configure with constraints.

        Args:
            tools: List of tool registrations with name, description, and parameters

        Returns:
            Registration response indicating success/failure
        """
        # Filter out already registered tools
        new_tools = [t for t in tools if t.name not in self._registered_tools]

        if not new_tools:
            self._log_debug("All tools already registered")
            return ToolRegistrationResponse(
                success=True,
                registered_tools=[],
                message="All tools already registered",
            )

        url = f"{self._base_url}/v1/tools/register"

        # Convert to JSON-serializable format
        payload = {
            "tools": [
                {
                    "name": t.name,
                    "description": t.description,
                    "parameters": [
                        {
                            "name": p.name,
                            "type": p.type,
                            "description": p.description,
                            "required": p.required,
                            "enum": p.enum,
                            "minimum": p.minimum,
                            "maximum": p.maximum,
                            "pattern": p.pattern,
                        }
                        for p in t.parameters
                    ],
                }
                for t in new_tools
            ]
        }

        self._log_debug("Registering tools with cloud", {"count": len(new_tools)})

        last_error: Optional[Exception] = None

        for attempt in range(self._config.retries + 1):
            try:
                session = self._get_session()
                async with session.post(
                    url,
                    json=payload,
                ) as response:
                    if not response.ok:
                        error_text = await response.text()
                        raise Exception(
                            f"API returned status {response.status}: {error_text}"
                        )

                    data = await response.json()

                    # Mark tools as registered
                    for tool in new_tools:
                        self._registered_tools.add(tool.name)

                    self._log_info(
                        "Tools registered successfully",
                        {"tools": [t.name for t in new_tools]},
                    )

                    return ToolRegistrationResponse(
                        success=True,
                        registered_tools=[t.name for t in new_tools],
                        message=data.get("message"),
                    )

            except Exception as error:
                last_error = error if isinstance(error, Exception) else Exception(str(error))

                if attempt < self._config.retries:
                    self._log_warn(
                        "Tool registration failed, retrying",
                        {"attempt": attempt + 1, "error": str(last_error)},
                    )
                    await asyncio.sleep(self._config.retry_delay / 1000)

        # All retries failed
        self._log_error(
            "Tool registration failed",
            {"error": str(last_error)},
            last_error,
        )

        return ToolRegistrationResponse(
            success=False,
            registered_tools=[],
            message=f"Registration failed: {last_error}",
        )

    async def validate(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        context: Optional[dict[str, Any]] = None,
    ) -> ValidationResponse:
        """
        Validate a tool call against cloud-managed policies.

        The cloud handles:
        - Deterministic validation (range checks, enum matching, regex, etc.)
        - LLM-assisted validation (when exceptions lists are configured)

        Args:
            tool_name: Name of the tool being called
            arguments: Arguments being passed to the tool
            context: Optional additional context/metadata

        Returns:
            Validation response with decision and any failed constraints
        """
        url = f"{self._base_url}/v1/tools/validate"

        payload = {
            "tool_name": tool_name,
            "arguments": arguments,
        }

        if context:
            payload["context"] = context

        self._log_debug(
            "Validating tool call",
            {"tool": tool_name, "arguments": arguments},
        )

        last_error: Optional[Exception] = None

        for attempt in range(self._config.retries + 1):
            try:
                session = self._get_session()
                async with session.post(
                    url,
                    json=payload,
                ) as response:
                    if not response.ok:
                        error_text = await response.text()
                        raise Exception(
                            f"API returned status {response.status}: {error_text}"
                        )

                    data = await response.json()

                    decision = data.get("decision", "deny")

                    # Parse failed constraints if present
                    failed_constraints = []
                    for fc in data.get("failed_constraints", []):
                        failed_constraints.append(
                            FailedConstraint(
                                parameter=fc.get("parameter", ""),
                                constraint_type=fc.get("constraint_type", ""),
                                expected=fc.get("expected"),
                                actual=fc.get("actual"),
                                message=fc.get("message", ""),
                            )
                        )

                    self._log_debug(
                        "Validation result",
                        {"tool": tool_name, "decision": decision},
                    )

                    denial = None
                    raw_denial = data.get("denial")
                    if isinstance(raw_denial, dict):
                        denial = CloudDenialDetails(
                            severity=raw_denial.get("severity", "deny"),
                            suggested_fixes=raw_denial.get("suggestedFixes", []),
                            policy_id=raw_denial.get("policyId"),
                            policy_name=raw_denial.get("policyName"),
                            matched_condition=raw_denial.get("matchedCondition"),
                            docs_url=raw_denial.get("docsUrl"),
                            input=raw_denial.get("input"),
                        )

                    return ValidationResponse(
                        decision=decision,
                        reason=data.get("reason"),
                        failed_constraints=failed_constraints,
                        metadata=data.get("metadata"),
                        approval_id=data.get("approval_id"),
                        denial=denial,
                        receipt=data.get("receipt") if isinstance(data.get("receipt"), dict) else None,
                    )

            except Exception as error:
                last_error = error if isinstance(error, Exception) else Exception(str(error))

                if attempt < self._config.retries:
                    self._log_warn(
                        "Validation request failed, retrying",
                        {"attempt": attempt + 1, "error": str(last_error)},
                    )
                    await asyncio.sleep(self._config.retry_delay / 1000)

        # All retries failed
        self._log_error(
            "Validation request failed",
            {"tool": tool_name, "error": str(last_error)},
            last_error,
        )

        # Return deny on failure (fail-closed for security)
        return ValidationResponse(
            decision="deny",
            reason=f"Validation failed: {last_error}",
            failed_constraints=[],
            metadata={"api_error": True},
        )

    async def export_receipts(
        self,
        *,
        project_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        cursor: Optional[str | int] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Export canonical receipt NDJSON from Veto Cloud."""
        if not self._api_key:
            raise ValueError("VETO_API_KEY or api_key is required for cloud receipt export")

        params: dict[str, str] = {"format": "ndjson"}
        if project_id:
            params["projectId"] = project_id
        if start_date:
            params["startDate"] = start_date
        if end_date:
            params["endDate"] = end_date
        if cursor is not None:
            params["cursor"] = _bounded_int(cursor, "cursor", 0, 2**53 - 1)
        if limit is not None:
            params["limit"] = _bounded_int(limit, "limit", 1, 10_000)

        session = self._get_session()
        chunks: list[str] = []
        next_cursor: Optional[str] = params.get("cursor")
        while True:
            if next_cursor is not None:
                params["cursor"] = next_cursor
            async with session.get(f"{self._base_url}/v1/receipts/export", params=params) as response:
                body = await response.text()
                if not response.ok:
                    raise RuntimeError(
                        f"receipt export returned HTTP {response.status}: {body}"
                    )
                chunks.append(body)
                header_cursor = response.headers.get("X-Veto-Next-Cursor")
                if not header_cursor:
                    break
                next_cursor = _bounded_int(header_cursor, "cursor", 0, 2**53 - 1)

        return "".join(chunks)

    async def poll_approval(
        self,
        approval_id: str,
        options: Optional[ApprovalPollOptions] = None,
    ) -> ApprovalData:
        """
        Poll an approval record until it is resolved or times out.

        Args:
            approval_id: The approval ID to poll
            options: Poll options (interval and timeout)

        Returns:
            The resolved approval data

        Raises:
            ApprovalTimeoutError: If the approval is not resolved within the timeout
        """
        opts = options or ApprovalPollOptions()
        url = f"{self._base_url}/v1/approvals/{approval_id}"
        deadline = time.monotonic() + opts.timeout

        self._log_info(
            "Polling for approval resolution",
            {"approval_id": approval_id, "timeout": opts.timeout},
        )

        session = self._get_session()
        while True:
            try:
                async with session.get(url) as response:
                    if not response.ok:
                        error_text = await response.text()
                        self._log_warn(
                            "Approval poll request failed",
                            {"status": response.status, "error": error_text},
                        )
                    else:
                        data: dict[str, Any] = await response.json()
                        status = data.get("status", "pending")

                        if status != "pending":
                            self._log_info(
                                "Approval resolved",
                                {"approval_id": approval_id, "status": status},
                            )
                            return ApprovalData(
                                id=data.get("id", approval_id),
                                status=status,
                                tool_name=data.get("toolName"),
                                resolved_by=data.get("resolvedBy"),
                            )

            except Exception as error:
                self._log_warn(
                    "Approval poll error",
                    {"approval_id": approval_id, "error": str(error)},
                )

            if time.monotonic() >= deadline:
                raise ApprovalTimeoutError(approval_id, opts.timeout)

            await asyncio.sleep(opts.poll_interval)

    async def create_runtime_action(
        self,
        request: RuntimeActionCreateRequest | dict[str, Any],
    ) -> RuntimeActionData:
        """Create a runtime action for the iOS approval wallet."""
        url = f"{self._base_url}/v1/runtime/actions"
        payload = self._runtime_action_request_payload(request)

        session = self._get_session()
        async with session.post(url, json=payload) as response:
            body = await response.text()
            if not response.ok:
                raise RuntimeError(f"API returned status {response.status}: {body}")
            data: dict[str, Any] = await response.json()
            return self._parse_runtime_action(data)

    async def wait_runtime_action(
        self,
        action_id: str,
        options: Optional[ApprovalPollOptions] = None,
    ) -> RuntimeActionData:
        """
        Long-poll a runtime action until it resolves or times out.

        Args:
            action_id: Runtime action ID returned by create_runtime_action
            options: Poll options (interval and total timeout)

        Returns:
            The terminal runtime action state.

        Raises:
            RuntimeActionTimeoutError: If the runtime action stays pending.
        """
        opts = options or ApprovalPollOptions()
        deadline = time.monotonic() + opts.timeout
        last_action: Optional[RuntimeActionData] = None

        self._log_info(
            "Waiting for runtime action resolution",
            {"action_id": action_id, "timeout": opts.timeout},
        )

        session = self._get_session()
        while True:
            client_timeout_seconds = self._config.timeout / 1000
            server_wait_seconds = min(
                30.0,
                client_timeout_seconds - 0.5
                if client_timeout_seconds > 1.5
                else client_timeout_seconds,
            )
            timeout_ms = max(1_000, int(server_wait_seconds * 1000))
            url = (
                f"{self._base_url}/v1/runtime/actions/"
                f"{quote(action_id, safe='')}/wait"
            )

            try:
                async with session.get(
                    url,
                    params={"timeoutMs": str(timeout_ms)},
                ) as response:
                    if not response.ok:
                        error_text = await response.text()
                        self._log_warn(
                            "Runtime action wait request failed",
                            {"status": response.status, "error": error_text},
                        )
                    else:
                        data: dict[str, Any] = await response.json()
                        action = self._parse_runtime_action(data)
                        last_action = action

                        if action.status != "pending":
                            self._log_info(
                                "Runtime action resolved",
                                {"action_id": action_id, "status": action.status},
                            )
                            return action

            except Exception as error:
                self._log_warn(
                    "Runtime action wait error",
                    {"action_id": action_id, "error": str(error)},
                )

            if time.monotonic() >= deadline:
                raise RuntimeActionTimeoutError(action_id, opts.timeout, last_action)

            await asyncio.sleep(opts.poll_interval)

    def _runtime_action_request_payload(
        self,
        request: RuntimeActionCreateRequest | dict[str, Any],
    ) -> dict[str, Any]:
        if isinstance(request, dict):
            return {key: value for key, value in request.items() if value is not None}

        payload: dict[str, Any] = {
            "agentId": request.agent_id,
            "actionIntent": request.action_intent,
            "toolName": request.tool_name,
            "toolCallPayload": request.tool_call_payload,
        }
        if request.project_id is not None:
            payload["projectId"] = request.project_id
        if request.agent_name is not None:
            payload["agentName"] = request.agent_name
        if request.agent_version is not None:
            payload["agentVersion"] = request.agent_version
        if request.raw_tool_call_payload is not None:
            payload["rawToolCallPayload"] = request.raw_tool_call_payload
        if request.timeout_seconds is not None:
            payload["timeoutSeconds"] = request.timeout_seconds
        if request.risk_score is not None:
            payload["riskScore"] = request.risk_score
        if request.session_id is not None:
            payload["sessionId"] = request.session_id
        if request.metadata is not None:
            payload["metadata"] = request.metadata
        return payload

    def _parse_runtime_action(self, data: dict[str, Any]) -> RuntimeActionData:
        return RuntimeActionData(
            id=data.get("id", ""),
            status=data.get("status", "pending"),
            organization_id=data.get("organizationId"),
            project_id=data.get("projectId"),
            decision_id=data.get("decisionId"),
            approval_id=data.get("approvalId"),
            agent_id=data.get("agentId"),
            agent_name=data.get("agentName"),
            action_intent=data.get("actionIntent"),
            tool_name=data.get("toolName"),
            tool_call_payload=data.get("toolCallPayload"),
            raw_tool_call_payload=data.get("rawToolCallPayload"),
            payload_hash=data.get("payloadHash"),
            payload_hash_algorithm=data.get("payloadHashAlgorithm"),
            request_ts=data.get("requestTs"),
            request_time=data.get("requestTime"),
            expires_at=data.get("expiresAt"),
            expires_at_ms=data.get("expiresAtMs"),
            timeout_ms=data.get("timeoutMs"),
            risk_score=data.get("riskScore"),
            session_id=data.get("sessionId"),
            metadata=data.get("metadata"),
            resolved_by=data.get("resolvedBy"),
            resolved_at=data.get("resolvedAt"),
            resolution_method=data.get("resolutionMethod"),
            web_resolution_reason=data.get("webResolutionReason"),
            device_id=data.get("deviceId"),
            ledger_entry_id=data.get("ledgerEntryId"),
            receipt_summary=data.get("receiptSummary"),
            ledger_entry=data.get("ledgerEntry"),
            stream=data.get("stream"),
        )

    async def fetch_policy(self, tool_name: str) -> "Optional[dict[str, Any]]":
        """Fetch a policy for a tool from the server."""
        url = f"{self._base_url}/v1/policies/{quote(tool_name, safe='')}"
        try:
            session = self._get_session()
            async with session.get(url) as response:
                if not response.ok:
                    return None
                data: dict[str, Any] = await response.json()
                return data
        except Exception:
            return None

    def log_decision(self, request: "dict[str, Any]") -> None:
        """Fire-and-forget: log a client-side decision to the server."""
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._do_log_decision(request))
        except RuntimeError:
            pass

    async def _do_log_decision(self, request: "dict[str, Any]") -> None:
        url = f"{self._base_url}/v1/decisions"
        try:
            session = self._get_session()
            await session.post(url, json=request)
        except Exception:
            self._log_debug("Failed to log decision", {"tool": request.get("tool_name")})

    def is_tool_registered(self, tool_name: str) -> bool:
        """Check if a tool has been registered with the cloud."""
        return tool_name in self._registered_tools

    def clear_registration_cache(self) -> None:
        """Clear the local cache of registered tools."""
        self._registered_tools.clear()


class ApprovalTimeoutError(Exception):
    """Error raised when an approval poll times out."""

    def __init__(self, approval_id: str, timeout: float):
        super().__init__(
            f"Approval {approval_id} was not resolved within {timeout}s"
        )
        self.approval_id = approval_id
        self.timeout = timeout


class RuntimeActionTimeoutError(Exception):
    """Error raised when a runtime action wait times out."""

    def __init__(
        self,
        action_id: str,
        timeout: float,
        last_action: Optional[RuntimeActionData] = None,
    ):
        super().__init__(
            f"Runtime action {action_id} was not resolved within {timeout}s"
        )
        self.action_id = action_id
        self.timeout = timeout
        self.last_action = last_action
