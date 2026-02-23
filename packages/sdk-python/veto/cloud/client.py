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
import aiohttp

from veto.cloud.types import (
    ToolRegistration,
    ToolRegistrationResponse,
    ValidationResponse,
    FailedConstraint,
    ApprovalData,
    ApprovalPollOptions,
)

if TYPE_CHECKING:
    from veto.utils.logger import Logger


# Default API base URL
DEFAULT_BASE_URL = "https://api.runveto.com"


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
        self._session: Optional[aiohttp.ClientSession] = None

    def _get_session(self) -> aiohttp.ClientSession:
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

                    return ValidationResponse(
                        decision=decision,
                        reason=data.get("reason"),
                        failed_constraints=failed_constraints,
                        metadata=data.get("metadata"),
                        approval_id=data.get("approval_id"),
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
