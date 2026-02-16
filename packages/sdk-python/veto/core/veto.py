"""
Main Veto guardrail class.

This is the primary entry point for using Veto. It wraps tools with validation
that is handled by the Veto Cloud API.
"""

from typing import (
    Any,
    Callable,
    Literal,
    Optional,
    TypeVar,
    Union,
    Awaitable,
    Protocol,
    runtime_checkable,
)
from dataclasses import dataclass
import os
import inspect

from veto.types.tool import ToolDefinition, ToolCall
from veto.types.config import (
    DecisionExportFormat,
    LogLevel,
    Validator,
    NamedValidator,
    ValidationContext,
    ValidationResult,
)
from veto.utils.logger import Logger, create_logger
from veto.utils.id import generate_tool_call_id
from veto.core.validator import ValidationEngine, ValidationEngineOptions
from veto.core.history import HistoryTracker, HistoryTrackerOptions, HistoryStats
from veto.core.interceptor import (
    Interceptor,
    InterceptorOptions,
    InterceptionResult,
    ToolCallDeniedError,
)
from veto.cloud.client import VetoCloudClient, VetoCloudConfig, ApprovalTimeoutError
from veto.cloud.types import ToolRegistration, ToolParameter, ApprovalPollOptions
from veto.cloud.policy_cache import PolicyCache
from veto.deterministic.validator import validate_deterministic
from veto.deterministic.types import LocalValidationResult


# Veto operating mode
VetoMode = Literal["strict", "log"]

# Wrapped handler function type
WrappedHandler = Callable[[dict[str, Any]], Awaitable[Any]]


@dataclass
class WrappedTools:
    """Result of wrapping tools with Veto."""

    definitions: list[ToolDefinition]
    implementations: dict[str, WrappedHandler]


@dataclass
class VetoOptions:
    """Options for creating a Veto instance."""

    # API key for Veto Cloud (can also use VETO_API_KEY env var)
    api_key: Optional[str] = None
    # Base URL for Veto Cloud API
    base_url: Optional[str] = None
    # Operating mode: "strict" blocks denied calls, "log" only logs
    mode: Optional[VetoMode] = None
    # Log level for Veto operations
    log_level: Optional[LogLevel] = None
    # Optional session ID for tracking
    session_id: Optional[str] = None
    # Optional agent ID for tracking
    agent_id: Optional[str] = None
    # Additional validators to run (in addition to cloud validation)
    validators: Optional[list[Union[Validator, NamedValidator]]] = None
    # API timeout in milliseconds
    timeout: Optional[int] = None
    # Number of retries for API calls
    retries: Optional[int] = None
    # Callback fired when a tool call requires human approval
    on_approval_required: Optional[Callable[..., Any]] = None
    # Seconds between approval poll requests (default: 2.0)
    approval_poll_interval: Optional[float] = None
    # Max seconds to wait for approval resolution (default: 300.0)
    approval_timeout: Optional[float] = None


@runtime_checkable
class ToolLike(Protocol):
    """Protocol for tool-like objects."""

    name: str


T = TypeVar("T", bound=ToolLike)


class Veto:
    """
    Veto - A guardrail system for AI agent tool calls.

    Veto wraps your tools and validates every call against policies managed
    in the Veto Cloud. Policies are auto-generated from your tool signatures
    and can be configured with constraints through the cloud dashboard.

    Example:
        >>> from veto import Veto
        >>>
        >>> # Initialize Veto (uses VETO_API_KEY env var)
        >>> veto = await Veto.init()
        >>>
        >>> # Wrap your tools (auto-registers with cloud)
        >>> wrapped_tools = veto.wrap(my_tools)
        >>>
        >>> # Pass to AI provider, validation is automatic
    """

    def __init__(
        self,
        options: VetoOptions,
        logger: Logger,
        cloud_client: VetoCloudClient,
    ):
        self._logger = logger
        self._mode: VetoMode = options.mode or "strict"
        self._cloud_client = cloud_client

        # Approval options
        self._on_approval_required = options.on_approval_required
        self._approval_poll_options = ApprovalPollOptions(
            poll_interval=options.approval_poll_interval or 2.0,
            timeout=options.approval_timeout or 300.0,
        )

        # Approval preference cache: tool_name -> "approve_all" | "deny_all"
        self._approval_preferences: dict[str, str] = {}

        # Resolve tracking options
        self._session_id = options.session_id or os.environ.get("VETO_SESSION_ID")
        self._agent_id = options.agent_id or os.environ.get("VETO_AGENT_ID")

        self._logger.info(
            "Veto configuration loaded",
            {
                "mode": self._mode,
                "base_url": cloud_client._base_url,
            },
        )

        # Initialize validation engine
        default_decision = "allow"
        self._validation_engine = ValidationEngine(
            ValidationEngineOptions(
                logger=self._logger, default_decision=default_decision
            )
        )

        # Add the cloud validator
        async def validate_with_cloud(ctx: ValidationContext) -> ValidationResult:
            return await self._validate_with_cloud(ctx)

        self._validation_engine.add_validator(
            NamedValidator(
                name="veto-cloud-validator",
                description="Validates tool calls via Veto Cloud API",
                priority=50,
                validate=validate_with_cloud,
            )
        )

        # Add any additional validators
        if options.validators:
            self._validation_engine.add_validators(options.validators)

        # Initialize history tracker
        self._history_tracker = HistoryTracker(
            HistoryTrackerOptions(max_size=100, logger=self._logger)
        )

        # Initialize interceptor
        self._interceptor = Interceptor(
            InterceptorOptions(
                logger=self._logger,
                validation_engine=self._validation_engine,
                history_tracker=self._history_tracker,
            )
        )

        # Initialize policy cache for client-side deterministic validation
        self._policy_cache = PolicyCache(self._cloud_client)

        self._logger.info("Veto initialized successfully")

    @classmethod
    async def init(cls, options: Optional[VetoOptions] = None) -> "Veto":
        """
        Initialize Veto.

        Args:
            options: Initialization options

        Returns:
            Initialized Veto instance

        Example:
            >>> # Use defaults (uses VETO_API_KEY env var)
            >>> veto = await Veto.init()
            >>>
            >>> # With explicit API key
            >>> veto = await Veto.init(VetoOptions(api_key='your-key'))
        """
        options = options or VetoOptions()

        # Determine log level
        env_log_level = os.environ.get("VETO_LOG_LEVEL")
        log_level: LogLevel = (
            options.log_level
            or (
                env_log_level
                if env_log_level in ("debug", "info", "warn", "error", "silent")
                else None
            )  # type: ignore[assignment]
            or "info"
        )

        logger = create_logger(log_level)

        # Create cloud client
        cloud_config = VetoCloudConfig(
            api_key=options.api_key,
            base_url=options.base_url
            or os.environ.get("VETO_API_URL", "https://api.veto.dev"),
            timeout=options.timeout or 30000,
            retries=options.retries or 2,
        )
        cloud_client = VetoCloudClient(cloud_config, logger)

        # Check for API key
        if not cloud_client._api_key:
            logger.warn(
                "No API key provided. Set VETO_API_KEY environment variable or pass api_key in options."
            )

        return cls(options, logger, cloud_client)

    def _extract_tool_signature(self, tool: Any) -> Optional[ToolRegistration]:
        """
        Extract tool signature for registration with cloud.

        Handles various tool formats (LangChain, custom, etc.)
        """
        tool_name = getattr(tool, "name", None)
        if not tool_name:
            return None

        description = getattr(tool, "description", None)

        # Try to extract parameters from various sources
        parameters: list[ToolParameter] = []

        # Try LangChain style args_schema (Pydantic model)
        args_schema = getattr(tool, "args_schema", None)
        if args_schema:
            try:
                schema = args_schema.model_json_schema()
                props = schema.get("properties", {})
                required = schema.get("required", [])

                for prop_name, prop_info in props.items():
                    param_type = prop_info.get("type", "string")
                    # Handle anyOf for Optional types
                    if "anyOf" in prop_info:
                        for any_type in prop_info["anyOf"]:
                            if any_type.get("type") != "null":
                                param_type = any_type.get("type", "string")
                                break

                    # Normalize JSON Schema "integer" to "number"
                    if param_type == "integer":
                        param_type = "number"

                    parameters.append(
                        ToolParameter(
                            name=prop_name,
                            type=param_type,
                            description=prop_info.get("description"),
                            required=prop_name in required,
                            enum=prop_info.get("enum"),
                            minimum=prop_info.get("minimum"),
                            maximum=prop_info.get("maximum"),
                            pattern=prop_info.get("pattern"),
                        )
                    )
            except Exception:
                pass

        # Try input_schema (ToolDefinition format)
        if not parameters:
            input_schema = getattr(tool, "input_schema", None)
            if input_schema and isinstance(input_schema, dict):
                props = input_schema.get("properties", {})
                required = input_schema.get("required", [])

                for prop_name, prop_info in props.items():
                    p_type = prop_info.get("type", "string")
                    if p_type == "integer":
                        p_type = "number"
                    parameters.append(
                        ToolParameter(
                            name=prop_name,
                            type=p_type,
                            description=prop_info.get("description"),
                            required=prop_name in required,
                            enum=prop_info.get("enum"),
                            minimum=prop_info.get("minimum"),
                            maximum=prop_info.get("maximum"),
                            pattern=prop_info.get("pattern"),
                        )
                    )

        # Try function signature inspection as fallback
        if not parameters:
            func = getattr(tool, "func", None) or getattr(tool, "handler", None)
            if func and callable(func):
                try:
                    sig = inspect.signature(func)
                    for param_name, param in sig.parameters.items():
                        if param_name in ("self", "cls"):
                            continue

                        param_type = "string"  # default
                        if param.annotation != inspect.Parameter.empty:
                            ann = param.annotation
                            if ann is int:
                                param_type = "number"
                            elif ann is float:
                                param_type = "number"
                            elif ann is bool:
                                param_type = "boolean"
                            elif ann is list:
                                param_type = "array"
                            elif ann is dict:
                                param_type = "object"

                        parameters.append(
                            ToolParameter(
                                name=param_name,
                                type=param_type,
                                required=param.default == inspect.Parameter.empty,
                            )
                        )
                except Exception:
                    pass

        return ToolRegistration(
            name=tool_name,
            description=description,
            parameters=parameters,
        )

    async def _register_tools_with_cloud(self, tools: list[Any]) -> None:
        """Register tools with the cloud for policy generation."""
        registrations: list[ToolRegistration] = []

        for tool in tools:
            registration = self._extract_tool_signature(tool)
            if registration:
                registrations.append(registration)
                self._logger.debug(
                    "Extracted tool signature",
                    {
                        "name": registration.name,
                        "params": len(registration.parameters),
                    },
                )

        if registrations:
            result = await self._cloud_client.register_tools(registrations)
            if result.success:
                self._logger.info(
                    "Tools registered with cloud",
                    {"tools": result.registered_tools},
                )
            else:
                self._logger.warn(
                    "Failed to register tools with cloud",
                    {"message": result.message},
                )

    def _try_local_deterministic(
        self, tool_name: str, args: dict[str, Any]
    ) -> Optional[LocalValidationResult]:
        policy = self._policy_cache.get(tool_name)
        if policy is None:
            return None

        if policy.mode != "deterministic":
            return None
        if policy.has_session_constraints or policy.has_rate_limits:
            return None

        result = validate_deterministic(tool_name, args, policy.constraints)

        self._cloud_client.log_decision(
            {
                "tool_name": tool_name,
                "arguments": args,
                "decision": result.decision,
                "reason": result.reason,
                "mode": "deterministic",
                "latency_ms": result.latency_ms,
                "source": "client",
                "context": {
                    "session_id": self._session_id,
                    "agent_id": self._agent_id,
                },
            }
        )

        return result

    async def _validate_with_cloud(
        self, context: ValidationContext
    ) -> ValidationResult:
        """Validate a tool call with the Veto Cloud API."""
        # Fast path: try client-side deterministic validation
        local_result = self._try_local_deterministic(
            context.tool_name, context.arguments
        )
        if local_result is not None:
            if local_result.decision == "allow":
                self._logger.debug(
                    "Local deterministic validation allowed",
                    {"tool": context.tool_name, "latency_ms": local_result.latency_ms},
                )
                return ValidationResult(decision="allow", reason=local_result.reason)

            if self._mode == "log":
                self._logger.warn(
                    "Tool call would be blocked locally (log mode)",
                    {"tool": context.tool_name, "reason": local_result.reason},
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"[LOG MODE] Would block: {local_result.reason}",
                    metadata={"blocked_in_strict_mode": True, "source": "client"},
                )

            self._logger.warn(
                "Tool call blocked by local deterministic validation",
                {"tool": context.tool_name, "reason": local_result.reason},
            )
            return ValidationResult(
                decision="deny",
                reason=local_result.reason,
                metadata={"source": "client"},
            )

        # Build context for cloud API
        api_context: dict[str, Any] = {
            "call_id": context.call_id,
            "timestamp": context.timestamp.isoformat(),
            "session_id": self._session_id,
            "agent_id": self._agent_id,
        }

        if context.custom:
            api_context["custom"] = context.custom

        try:
            response = await self._cloud_client.validate(
                tool_name=context.tool_name,
                arguments=context.arguments,
                context=api_context,
            )
        except Exception as exc:
            reason = str(exc)
            if self._mode == "log":
                self._logger.warn(
                    "Cloud unavailable (log mode, allowing)",
                    {"reason": reason},
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"Cloud unavailable: {reason}",
                    metadata={"cloud_error": True},
                )
            self._logger.error(
                "Cloud unavailable (strict mode, blocking)",
                {"reason": reason},
            )
            return ValidationResult(
                decision="deny",
                reason=f"Cloud unavailable: {reason}",
                metadata={"cloud_error": True},
            )

        # Build metadata
        metadata: dict[str, Any] = {}
        if response.failed_constraints:
            metadata["failed_constraints"] = [
                {
                    "parameter": fc.parameter,
                    "constraint_type": fc.constraint_type,
                    "expected": fc.expected,
                    "actual": fc.actual,
                    "message": fc.message,
                }
                for fc in response.failed_constraints
            ]
        if response.metadata:
            metadata.update(response.metadata)

        if response.decision == "require_approval" and response.approval_id:
            # Check approval preference cache first
            cached_pref = self._approval_preferences.get(context.tool_name)
            if cached_pref == "approve_all":
                self._logger.info(
                    "Auto-approved via cached preference",
                    {"tool": context.tool_name},
                )
                return ValidationResult(
                    decision="allow",
                    reason="Auto-approved (approve all preference)",
                    metadata=metadata if metadata else None,
                )
            elif cached_pref == "deny_all":
                self._logger.info(
                    "Auto-denied via cached preference",
                    {"tool": context.tool_name},
                )
                return ValidationResult(
                    decision="deny",
                    reason="Auto-denied (deny all preference)",
                    metadata=metadata if metadata else None,
                )

            self._logger.info(
                "Awaiting human approval",
                {"tool": context.tool_name, "approval_id": response.approval_id},
            )

            # Fire on_approval_required hook with full context
            if self._on_approval_required:
                try:
                    hook_result = self._on_approval_required(
                        context,
                        response.approval_id,
                    )
                    if inspect.isawaitable(hook_result):
                        await hook_result
                except Exception as hook_err:
                    self._logger.warn(
                        "on_approval_required hook error",
                        {"error": str(hook_err)},
                    )

            try:
                approval_data = await self._cloud_client.poll_approval(
                    response.approval_id,
                    options=self._approval_poll_options,
                )
                if approval_data.status == "approved":
                    self._logger.info(
                        "Approval granted",
                        {
                            "tool": context.tool_name,
                            "approval_id": response.approval_id,
                        },
                    )
                    return ValidationResult(
                        decision="allow",
                        reason=f"Approved by human: {approval_data.resolved_by or 'unknown'}",
                        metadata=metadata if metadata else None,
                    )
                else:
                    self._logger.warn(
                        "Approval denied or expired",
                        {"tool": context.tool_name, "status": approval_data.status},
                    )
                    return ValidationResult(
                        decision="deny",
                        reason=f"Approval {approval_data.status}: {response.reason}",
                        metadata=metadata if metadata else None,
                    )
            except ApprovalTimeoutError:
                self._logger.warn(
                    "Approval timed out",
                    {"tool": context.tool_name, "approval_id": response.approval_id},
                )
                return ValidationResult(
                    decision="deny",
                    reason="Approval timed out waiting for human review",
                    metadata=metadata if metadata else None,
                )

        if response.decision == "allow":
            self._logger.debug(
                "Cloud allowed tool call",
                {"tool": context.tool_name},
            )
            return ValidationResult(
                decision="allow",
                reason=response.reason,
                metadata=metadata if metadata else None,
            )
        else:
            # Cloud returned deny decision
            if self._mode == "log":
                # Log mode: log the block but allow the call
                self._logger.warn(
                    "Tool call would be blocked (log mode)",
                    {
                        "tool": context.tool_name,
                        "reason": response.reason,
                        "failed_constraints": [
                            fc.message for fc in response.failed_constraints
                        ],
                    },
                )
                return ValidationResult(
                    decision="allow",
                    reason=f"[LOG MODE] Would block: {response.reason}",
                    metadata={**metadata, "blocked_in_strict_mode": True},
                )
            else:
                # Strict mode: actually block the call
                self._logger.warn(
                    "Tool call blocked",
                    {
                        "tool": context.tool_name,
                        "reason": response.reason,
                        "failed_constraints": [
                            fc.message for fc in response.failed_constraints
                        ],
                    },
                )
                return ValidationResult(
                    decision="deny",
                    reason=response.reason,
                    metadata=metadata if metadata else None,
                )

    def wrap(self, tools: list[T]) -> list[T]:
        """
        Wrap tools with Veto validation.

        This method:
        1. Extracts tool signatures and registers them with Veto Cloud
        2. Wraps each tool to intercept calls and validate against cloud policies

        Args:
            tools: Array of tools to wrap (LangChain, custom, etc.)

        Returns:
            The same tools with Veto validation injected

        Example:
            >>> from langchain.tools import tool
            >>> from veto import Veto
            >>>
            >>> @tool
            >>> def search(query: str) -> str:
            ...     return f"Results for: {query}"
            >>>
            >>> veto = await Veto.init()
            >>> wrapped_tools = veto.wrap([search])
        """
        import asyncio

        # Register tools with cloud (fire and forget, don't block wrapping)
        try:
            asyncio.get_running_loop()
            asyncio.create_task(self._register_tools_with_cloud(tools))
        except RuntimeError:
            # No running event loop — run synchronously
            asyncio.run(self._register_tools_with_cloud(tools))

        return [self.wrap_tool(tool) for tool in tools]

    def wrap_tool(self, tool: T) -> T:
        """
        Wrap a single tool with Veto validation.

        Args:
            tool: The tool to wrap

        Returns:
            The same tool with Veto validation injected
        """
        tool_name = tool.name
        veto = self

        # For LangChain tools, we need to wrap the 'func' property
        if hasattr(tool, "func") and callable(getattr(tool, "func")):
            original_func = getattr(tool, "func")

            async def wrapped_func(input_data: dict[str, Any]) -> Any:
                # Validate with Veto
                result = await veto.validate_tool_call(
                    ToolCall(
                        id=generate_tool_call_id(),
                        name=tool_name,
                        arguments=input_data,
                    )
                )

                if not result.allowed:
                    raise ToolCallDeniedError(
                        tool_name,
                        result.original_call.id or "",
                        result.validation_result,
                    )

                # Execute the original function with potentially modified arguments
                final_args = result.final_arguments or input_data
                if inspect.iscoroutinefunction(original_func):
                    return await original_func(final_args)
                return original_func(final_args)

            # Create a copy of the tool with the wrapped function
            try:
                import copy

                wrapped = copy.copy(tool)
                object.__setattr__(wrapped, "func", wrapped_func)

                # Also wrap ainvoke if it exists (LangChain async method)
                if hasattr(tool, "ainvoke"):
                    original_ainvoke = getattr(tool, "ainvoke")

                    async def wrapped_ainvoke(
                        input_data: dict[str, Any], *args: Any, **kwargs: Any
                    ) -> Any:
                        # LangGraph passes a ToolCall dict with args nested
                        if (
                            isinstance(input_data, dict)
                            and "args" in input_data
                            and "name" in input_data
                        ):
                            call_arguments = input_data["args"]
                        else:
                            call_arguments = input_data

                        # Validate with Veto first
                        result = await veto.validate_tool_call(
                            ToolCall(
                                id=generate_tool_call_id(),
                                name=tool_name,
                                arguments=call_arguments,
                            )
                        )

                        if not result.allowed:
                            raise ToolCallDeniedError(
                                tool_name,
                                result.original_call.id or "",
                                result.validation_result,
                            )

                        # Call original ainvoke with the original input format
                        return await original_ainvoke(input_data, *args, **kwargs)

                    object.__setattr__(wrapped, "ainvoke", wrapped_ainvoke)

                # Also wrap sync invoke if it exists
                if hasattr(tool, "invoke"):
                    original_invoke = getattr(tool, "invoke")

                    def wrapped_invoke(
                        input_data: dict[str, Any], *args: Any, **kwargs: Any
                    ) -> Any:
                        # For sync invoke, we run validation in a new event loop
                        import asyncio

                        async def validate_and_invoke() -> dict[str, Any]:
                            result = await veto.validate_tool_call(
                                ToolCall(
                                    id=generate_tool_call_id(),
                                    name=tool_name,
                                    arguments=input_data,
                                )
                            )

                            if not result.allowed:
                                raise ToolCallDeniedError(
                                    tool_name,
                                    result.original_call.id or "",
                                    result.validation_result,
                                )

                            return result.final_arguments or input_data

                        import concurrent.futures

                        try:
                            loop = asyncio.get_running_loop()
                        except RuntimeError:
                            loop = None

                        if loop is not None and loop.is_running():
                            # Inside a running async loop — run validation
                            # in a separate thread with its own event loop
                            with concurrent.futures.ThreadPoolExecutor(
                                max_workers=1
                            ) as pool:
                                final_args = pool.submit(
                                    asyncio.run, validate_and_invoke()
                                ).result()
                            return original_invoke(final_args, *args, **kwargs)

                        # No running loop — use asyncio.run directly
                        final_args = asyncio.run(validate_and_invoke())
                        return original_invoke(final_args, *args, **kwargs)

                    object.__setattr__(wrapped, "invoke", wrapped_invoke)

                veto._logger.debug("Tool wrapped", {"name": tool_name})
                return wrapped
            except Exception:
                pass

        # Fallback for other tool types (handler, run, execute, etc.)
        exec_function_keys = ["handler", "run", "execute", "call", "_call"]

        for key in exec_function_keys:
            if hasattr(tool, key) and callable(getattr(tool, key)):
                original_func = getattr(tool, key)

                def create_wrapper(orig: Any) -> Any:
                    async def wrapper(*args: Any, **kwargs: Any) -> Any:
                        if len(args) == 1 and isinstance(args[0], dict):
                            call_args = args[0]
                        elif kwargs:
                            call_args = kwargs
                        else:
                            call_args = {"args": args}

                        result = await veto.validate_tool_call(
                            ToolCall(
                                id=generate_tool_call_id(),
                                name=tool_name,
                                arguments=call_args,
                            )
                        )

                        if not result.allowed:
                            raise ToolCallDeniedError(
                                tool_name,
                                result.original_call.id or "",
                                result.validation_result,
                            )

                        final_args = result.final_arguments or call_args
                        if len(args) == 1 and isinstance(args[0], dict):
                            if inspect.iscoroutinefunction(orig):
                                return await orig(final_args)
                            return orig(final_args)
                        if inspect.iscoroutinefunction(orig):
                            return await orig(*args, **kwargs)
                        return orig(*args, **kwargs)

                    return wrapper

                try:
                    import copy

                    wrapped = copy.copy(tool)
                    object.__setattr__(wrapped, key, create_wrapper(original_func))
                    veto._logger.debug("Tool wrapped", {"name": tool_name})
                    return wrapped
                except Exception:
                    pass

        # No wrappable function found, return as-is
        veto._logger.warn("No wrappable function found on tool", {"name": tool_name})
        return tool

    async def validate_tool_call(self, call: ToolCall) -> InterceptionResult:
        """Validate a tool call through the interceptor pipeline.

        Used internally by ``wrap()`` and by framework integrations
        (LangChain) to validate tool calls against configured rules
        and policies.
        """
        normalized_call = ToolCall(
            id=call.id or generate_tool_call_id(),
            name=call.name,
            arguments=call.arguments,
            raw_arguments=call.raw_arguments,
        )

        return await self._interceptor.intercept(normalized_call)

    def set_approval_preference(self, tool_name: str, preference: str) -> None:
        """
        Cache an approval preference for a tool.

        When set, subsequent require_approval decisions for this tool
        are auto-resolved from the cache without polling the server.

        Args:
            tool_name: The tool to set the preference for
            preference: "approve_all" or "deny_all"
        """
        if preference not in ("approve_all", "deny_all"):
            raise ValueError(
                f"Invalid preference: {preference}. Use 'approve_all' or 'deny_all'."
            )
        self._approval_preferences[tool_name] = preference
        self._logger.info(
            "Approval preference set",
            {"tool": tool_name, "preference": preference},
        )

    def clear_approval_preferences(self, tool_name: Optional[str] = None) -> None:
        """
        Clear cached approval preferences.

        Args:
            tool_name: If provided, clear only for this tool. Otherwise clear all.
        """
        if tool_name:
            self._approval_preferences.pop(tool_name, None)
        else:
            self._approval_preferences.clear()

    def get_approval_preference(self, tool_name: str) -> Optional[str]:
        """Get the cached approval preference for a tool, if any."""
        return self._approval_preferences.get(tool_name)

    def get_history_stats(self) -> HistoryStats:
        """Get history statistics."""
        return self._history_tracker.get_stats()

    def export_decisions(self, format: DecisionExportFormat = "json") -> str:
        """Export decision history as JSON or CSV."""
        return self._history_tracker.export_decisions(format)

    def clear_history(self) -> None:
        """Clear call history."""
        self._history_tracker.clear()


# Re-export error class
__all__ = [
    "Veto",
    "ToolCallDeniedError",
    "VetoOptions",
    "VetoMode",
    "WrappedTools",
    "WrappedHandler",
]
