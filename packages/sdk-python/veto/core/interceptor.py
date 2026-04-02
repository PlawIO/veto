"""
Tool call interceptor.

This module handles intercepting tool calls from the AI model
and routing them through the validation pipeline.
"""

from typing import Any, Callable, Optional, Protocol, Union, Awaitable
from dataclasses import dataclass
from datetime import datetime
import inspect
import time

from veto.types.tool import ToolCall, ToolResult, ExecutableTool
from veto.types.config import ValidationContext, ValidationResult
from veto.utils.logger import Logger
from veto.utils.id import generate_tool_call_id
from veto.core.validator import ValidationEngine, AggregatedValidationResult
from veto.core.history import HistoryTracker
from veto.core.output_validator import OutputValidationResult


class OutputValidationProtocol(Protocol):
    def validate(
        self, tool_name: str, output: Any
    ) -> Union[OutputValidationResult, Awaitable[OutputValidationResult]]:
        ...


@dataclass
class InterceptorOptions:
    """Options for the interceptor."""

    logger: Logger
    validation_engine: ValidationEngine
    history_tracker: Optional[HistoryTracker] = None
    session_id: Optional[str] = None
    agent_id: Optional[str] = None
    user_id: Optional[str] = None
    role: Optional[str] = None
    custom_context: Optional[dict[str, Any]] = None
    on_before_validation: Optional[
        Callable[[ValidationContext], Union[None, Awaitable[None]]]
    ] = None
    on_after_validation: Optional[
        Callable[
            [ValidationContext, ValidationResult], Union[None, Awaitable[None]]
        ]
    ] = None
    on_denied: Optional[
        Callable[
            [ValidationContext, ValidationResult], Union[None, Awaitable[None]]
        ]
    ] = None
    output_validator: Optional[OutputValidationProtocol] = None


@dataclass
class InterceptionResult:
    """Result of intercepting a tool call."""

    allowed: bool
    validation_result: ValidationResult
    aggregated_result: AggregatedValidationResult
    original_call: ToolCall
    final_arguments: dict[str, Any]


@dataclass
class DenialDetails:
    """Structured denial details from the server."""

    severity: Optional[str] = None
    suggested_fixes: Optional[list[str]] = None
    policy_id: Optional[str] = None
    policy_name: Optional[str] = None
    matched_condition: Optional[str] = None
    docs_url: Optional[str] = None
    input: Optional[dict[str, Any]] = None


class ToolCallDeniedError(Exception):
    """Error thrown when a tool call is denied."""

    def __init__(
        self,
        tool_name: str,
        call_id: str,
        validation_result: ValidationResult,
        denial: Optional[DenialDetails] = None,
    ):
        reason = validation_result.reason or "Tool call denied"
        super().__init__(self._format_message(tool_name, reason, denial))
        self.tool_name = tool_name
        self.call_id = call_id
        self.reason = reason
        self.validation_result = validation_result
        self.policy_id = denial.policy_id if denial else None
        self.policy_name = denial.policy_name if denial else None
        self.severity = denial.severity if denial else None
        self.matched_condition = denial.matched_condition if denial else None
        self.suggested_fixes = (denial.suggested_fixes or []) if denial else []
        self.docs_url = denial.docs_url if denial else None

    @staticmethod
    def _format_message(
        tool_name: str,
        reason: str,
        denial: Optional[DenialDetails] = None,
    ) -> str:
        if not denial:
            return f"Tool call denied: {tool_name} - {reason}"

        lines: list[str] = [f"Veto denied {tool_name}", ""]
        if denial.policy_name:
            lines.append(f"Policy:   {denial.policy_name}")
        lines.append(f"Reason:   {reason}")
        if denial.matched_condition:
            lines.append(f"Rule:     {denial.matched_condition}")
        if denial.input:
            import json

            input_str = json.dumps(denial.input)
            if len(input_str) > 120:
                input_str = input_str[:117] + "..."
            lines.append(f"Input:    {input_str}")

        if denial.suggested_fixes:
            lines.append("")
            lines.append("To resolve:")
            for fix in denial.suggested_fixes:
                lines.append(f"  - {fix}")

        if denial.docs_url:
            lines.append("")
            lines.append(denial.docs_url)

        return "\n".join(lines)


class Interceptor:
    """Tool call interceptor that routes calls through validation."""

    def __init__(self, options: InterceptorOptions):
        self._logger = options.logger
        self._validation_engine = options.validation_engine
        self._history_tracker = options.history_tracker
        self._session_id = options.session_id
        self._agent_id = options.agent_id
        self._user_id = options.user_id
        self._role = options.role
        self._custom_context = options.custom_context
        self._on_before_validation = options.on_before_validation
        self._on_after_validation = options.on_after_validation
        self._on_denied = options.on_denied
        self._output_validator = options.output_validator

    async def intercept(self, call: ToolCall) -> InterceptionResult:
        """
        Intercept and validate a tool call.

        Args:
            call: The tool call to intercept

        Returns:
            The interception result
        """
        call_id = call.id or generate_tool_call_id()

        self._logger.info(
            "Intercepting tool call",
            {"tool_name": call.name, "call_id": call_id},
        )

        # Build validation context
        context = ValidationContext(
            tool_name=call.name,
            arguments=call.arguments,
            call_id=call_id,
            timestamp=datetime.now(),
            call_history=(
                self._history_tracker.get_all()
                if self._history_tracker
                else []
            ),
            session_id=self._session_id,
            agent_id=self._agent_id,
            user_id=self._user_id,
            role=self._role,
            source="interceptor",
            custom=self._custom_context,
        )

        # Run before hook
        if self._on_before_validation:
            try:
                result = self._on_before_validation(context)
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                self._logger.warn(
                    "on_before_validation hook threw an error",
                    {
                        "call_id": call_id,
                        "error": str(error),
                    },
                )

        # Run validation
        aggregated_result = await self._validation_engine.validate(context)
        validation_result = aggregated_result.final_result
        is_shadow_override = bool(
            validation_result.metadata
            and validation_result.metadata.get("shadow") is True
        )

        # Determine final arguments (may be modified by validators)
        final_arguments = (
            validation_result.modified_arguments
            if validation_result.decision == "modify"
            and validation_result.modified_arguments
            else call.arguments
        )

        # Record in history
        if self._history_tracker:
            self._history_tracker.record(
                call.name,
                call.arguments,
                validation_result,
                aggregated_result.total_duration_ms,
            )

        # Run after hook
        if self._on_after_validation:
            try:
                result = self._on_after_validation(context, validation_result)
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                self._logger.warn(
                    "on_after_validation hook threw an error",
                    {
                        "call_id": call_id,
                        "error": str(error),
                    },
                )

        # Handle denial
        if validation_result.decision == "deny" and not is_shadow_override:
            if self._on_denied:
                try:
                    result = self._on_denied(context, validation_result)
                    if inspect.isawaitable(result):
                        await result
                except Exception as error:
                    self._logger.warn(
                        "on_denied hook threw an error",
                        {
                            "call_id": call_id,
                            "error": str(error),
                        },
                    )

            self._logger.warn(
                "Tool call denied",
                {
                    "tool_name": call.name,
                    "call_id": call_id,
                    "reason": validation_result.reason,
                },
            )
        elif validation_result.decision == "deny" and is_shadow_override:
            self._logger.warn(
                "Tool call would be denied in shadow mode (continuing)",
                {
                    "tool_name": call.name,
                    "call_id": call_id,
                    "reason": validation_result.reason,
                },
            )
        else:
            self._logger.info(
                "Tool call allowed",
                {
                    "tool_name": call.name,
                    "call_id": call_id,
                    "decision": validation_result.decision,
                    "was_modified": validation_result.decision == "modify",
                },
            )

        return InterceptionResult(
            allowed=validation_result.decision != "deny" or is_shadow_override,
            validation_result=validation_result,
            aggregated_result=aggregated_result,
            original_call=call,
            final_arguments=final_arguments,
        )

    async def intercept_or_throw(self, call: ToolCall) -> InterceptionResult:
        """
        Intercept a tool call and throw if denied.

        Args:
            call: The tool call to intercept

        Returns:
            The interception result (only if allowed)

        Raises:
            ToolCallDeniedError: If the call is denied
        """
        result = await self.intercept(call)

        if not result.allowed:
            denial = None
            raw_denial = (
                result.validation_result.metadata.get("denial")
                if result.validation_result.metadata
                else None
            )
            if raw_denial is not None:
                if isinstance(raw_denial, DenialDetails):
                    denial = raw_denial
                elif isinstance(raw_denial, dict):
                    denial = DenialDetails(
                        severity=raw_denial.get("severity"),
                        suggested_fixes=raw_denial.get("suggestedFixes", []),
                        policy_id=raw_denial.get("policyId"),
                        policy_name=raw_denial.get("policyName"),
                        matched_condition=raw_denial.get("matchedCondition"),
                        docs_url=raw_denial.get("docsUrl"),
                        input=raw_denial.get("input"),
                    )
                else:
                    # CloudDenialDetails dataclass from cloud/types
                    denial = DenialDetails(
                        severity=getattr(raw_denial, "severity", None),
                        suggested_fixes=getattr(raw_denial, "suggested_fixes", []),
                        policy_id=getattr(raw_denial, "policy_id", None),
                        policy_name=getattr(raw_denial, "policy_name", None),
                        matched_condition=getattr(raw_denial, "matched_condition", None),
                        docs_url=getattr(raw_denial, "docs_url", None),
                        input=getattr(raw_denial, "input", None),
                    )
            raise ToolCallDeniedError(
                call.name,
                call.id or "unknown",
                result.validation_result,
                denial,
            )

        return result

    async def intercept_and_execute(
        self,
        call: ToolCall,
        tools: list[ExecutableTool],
    ) -> ToolResult:
        """
        Intercept and execute a tool call.

        If the call is allowed and the tool has a handler, executes the handler.

        Args:
            call: The tool call to execute
            tools: Available tools with handlers

        Returns:
            The tool result
        """
        result = await self.intercept(call)

        if not result.allowed:
            return ToolResult(
                tool_call_id=call.id or generate_tool_call_id(),
                tool_name=call.name,
                content={
                    "error": "Tool call denied",
                    "reason": result.validation_result.reason,
                },
                is_error=True,
            )

        # Find the tool
        tool = None
        for t in tools:
            if t.name == call.name:
                tool = t
                break

        if not tool:
            self._logger.error(
                "Tool not found for execution",
                {
                    "tool_name": call.name,
                    "available_tools": [t.name for t in tools],
                },
            )
            return ToolResult(
                tool_call_id=call.id or generate_tool_call_id(),
                tool_name=call.name,
                content={
                    "error": "Tool not found",
                    "message": f'No tool named "{call.name}" is registered',
                },
                is_error=True,
            )

        # Execute the tool
        start_time = time.perf_counter()
        try:
            handler_result = tool.handler(result.final_arguments)
            if inspect.isawaitable(handler_result):
                content = await handler_result
            else:
                content = handler_result
            duration_ms = (time.perf_counter() - start_time) * 1000

            final_content = content
            if self._output_validator is not None:
                output_validation = self._output_validator.validate(call.name, content)
                if inspect.isawaitable(output_validation):
                    output_result = await output_validation
                else:
                    output_result = output_validation

                if output_result.decision == "block":
                    self._logger.warn(
                        "Tool output blocked",
                        {
                            "tool_name": call.name,
                            "reason": output_result.reason,
                            "matched_rule_ids": output_result.matched_rule_ids,
                        },
                    )
                    return ToolResult(
                        tool_call_id=call.id or generate_tool_call_id(),
                        tool_name=call.name,
                        content={
                            "error": "Tool output blocked",
                            "reason": output_result.reason,
                        },
                        is_error=True,
                    )

                final_content = output_result.output

            self._logger.debug(
                "Tool executed successfully",
                {
                    "tool_name": call.name,
                    "duration_ms": round(duration_ms, 2),
                },
            )

            return ToolResult(
                tool_call_id=call.id or generate_tool_call_id(),
                tool_name=call.name,
                content=final_content,
                is_error=False,
            )
        except Exception as error:
            duration_ms = (time.perf_counter() - start_time) * 1000
            error_message = str(error)

            self._logger.error(
                "Tool execution failed",
                {
                    "tool_name": call.name,
                    "duration_ms": round(duration_ms, 2),
                },
                error if isinstance(error, Exception) else None,
            )

            return ToolResult(
                tool_call_id=call.id or generate_tool_call_id(),
                tool_name=call.name,
                content={
                    "error": "Tool execution failed",
                    "message": error_message,
                },
                is_error=True,
            )
