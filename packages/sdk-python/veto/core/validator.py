"""
Validation engine for tool calls.

This module handles running validators and aggregating their results.
"""

from typing import Union
from dataclasses import dataclass
import inspect
import time

from veto.types.config import (
    NamedValidator,
    ValidationContext,
    ValidationResult,
    Validator,
    normalize_validator,
)
from veto.utils.logger import Logger


@dataclass
class ValidationEngineOptions:
    """Options for the validation engine."""

    logger: Logger
    default_decision: str = "allow"


@dataclass
class ValidatorResult:
    """Result from an individual validator."""

    validator_name: str
    result: ValidationResult
    duration_ms: float


@dataclass
class AggregatedValidationResult:
    """Result of running all validators."""

    final_result: ValidationResult
    validator_results: list[ValidatorResult]
    total_duration_ms: float


class ValidationEngine:
    """Validation engine that runs multiple validators in sequence."""

    def __init__(self, options: ValidationEngineOptions):
        self._validators: list[NamedValidator] = []
        self._logger = options.logger
        self._default_decision = options.default_decision

    def add_validator(
        self, validator: Union[Validator, NamedValidator]
    ) -> None:
        """
        Add a validator to the engine.

        Args:
            validator: Validator function or named validator
        """
        normalized = normalize_validator(validator, len(self._validators))
        self._validators.append(normalized)
        self._sort_validators()
        self._logger.debug(
            "Validator added",
            {
                "name": normalized.name,
                "priority": normalized.priority,
                "total_validators": len(self._validators),
            },
        )

    def add_validators(
        self, validators: list[Union[Validator, NamedValidator]]
    ) -> None:
        """
        Add multiple validators at once.

        Args:
            validators: Array of validators to add
        """
        for validator in validators:
            normalized = normalize_validator(validator, len(self._validators))
            self._validators.append(normalized)
        self._sort_validators()
        self._logger.debug(
            "Validators added",
            {
                "count": len(validators),
                "total_validators": len(self._validators),
            },
        )

    def remove_validator(self, name: str) -> bool:
        """
        Remove a validator by name.

        Args:
            name: Name of the validator to remove

        Returns:
            True if the validator was found and removed
        """
        for i, v in enumerate(self._validators):
            if v.name == name:
                self._validators.pop(i)
                self._logger.debug("Validator removed", {"name": name})
                return True
        return False

    def clear_validators(self) -> None:
        """Clear all validators."""
        self._validators.clear()
        self._logger.debug("All validators cleared")

    def get_validators(self) -> list[NamedValidator]:
        """Get the current list of validators."""
        return list(self._validators)

    async def validate(
        self, context: ValidationContext
    ) -> AggregatedValidationResult:
        """
        Run all applicable validators for a tool call.

        Validators run in priority order. If any validator returns 'deny',
        validation stops immediately and returns the denial.

        Args:
            context: Validation context

        Returns:
            Aggregated validation result
        """
        start_time = time.perf_counter()
        validator_results: list[ValidatorResult] = []

        # Get validators that apply to this tool
        applicable_validators = self._get_applicable_validators(
            context.tool_name
        )

        self._logger.debug(
            "Starting validation",
            {
                "tool_name": context.tool_name,
                "call_id": context.call_id,
                "validator_count": len(applicable_validators),
            },
        )

        # If no validators, return default decision
        if len(applicable_validators) == 0:
            from veto.types.config import ValidationDecision
            decision: ValidationDecision = "allow" if self._default_decision == "allow" else "deny"
            default_result = ValidationResult(decision=decision)
            self._logger.debug(
                "No applicable validators, using default decision",
                {"decision": self._default_decision},
            )
            return AggregatedValidationResult(
                final_result=default_result,
                validator_results=[],
                total_duration_ms=(time.perf_counter() - start_time) * 1000,
            )

        final_result = ValidationResult(decision="allow")
        current_context = context

        # Run validators in sequence
        for validator in applicable_validators:
            validator_start = time.perf_counter()

            try:
                # Handle both sync and async validators
                result = validator.validate(current_context)
                if inspect.isawaitable(result):
                    result = await result

                duration_ms = (time.perf_counter() - validator_start) * 1000

                validator_results.append(
                    ValidatorResult(
                        validator_name=validator.name,
                        result=result,
                        duration_ms=duration_ms,
                    )
                )

                self._logger.debug(
                    "Validator completed",
                    {
                        "validator_name": validator.name,
                        "decision": result.decision,
                        "duration_ms": round(duration_ms, 2),
                    },
                )

                # Handle different decisions
                if result.decision == "deny":
                    # Stop on first denial
                    final_result = result
                    self._logger.info(
                        "Tool call denied by validator",
                        {
                            "tool_name": context.tool_name,
                            "call_id": context.call_id,
                            "validator": validator.name,
                            "reason": result.reason,
                        },
                    )
                    break
                elif result.decision == "require_approval":
                    # Stop on approval requirement so callers can route to HITL.
                    final_result = result
                    self._logger.info(
                        "Tool call requires approval by validator",
                        {
                            "tool_name": context.tool_name,
                            "call_id": context.call_id,
                            "validator": validator.name,
                            "reason": result.reason,
                        },
                    )
                    break
                elif (
                    result.decision == "modify"
                    and result.modified_arguments
                ):
                    # Update context with modified arguments for next validator
                    current_context = ValidationContext(
                        tool_name=current_context.tool_name,
                        arguments=result.modified_arguments,
                        call_id=current_context.call_id,
                        timestamp=current_context.timestamp,
                        call_history=current_context.call_history,
                        session_id=current_context.session_id,
                        agent_id=current_context.agent_id,
                        user_id=current_context.user_id,
                        role=current_context.role,
                        source=current_context.source,
                        custom=current_context.custom,
                    )
                    final_result = result
                elif result.decision == "allow":
                    # Continue to next validator
                    final_result = result

            except Exception as error:
                duration_ms = (time.perf_counter() - validator_start) * 1000
                error_message = str(error)

                self._logger.error(
                    "Validator threw an error",
                    {
                        "validator_name": validator.name,
                        "tool_name": context.tool_name,
                        "call_id": context.call_id,
                    },
                    error if isinstance(error, Exception) else None,
                )

                # Treat validator errors as denials for safety
                validator_results.append(
                    ValidatorResult(
                        validator_name=validator.name,
                        result=ValidationResult(
                            decision="deny",
                            reason=f"Validator error: {error_message}",
                        ),
                        duration_ms=duration_ms,
                    )
                )

                final_result = ValidationResult(
                    decision="deny",
                    reason=f'Validator "{validator.name}" threw an error: {error_message}',
                )
                break

        total_duration_ms = (time.perf_counter() - start_time) * 1000

        self._logger.debug(
            "Validation complete",
            {
                "tool_name": context.tool_name,
                "call_id": context.call_id,
                "final_decision": final_result.decision,
                "total_duration_ms": round(total_duration_ms, 2),
            },
        )

        return AggregatedValidationResult(
            final_result=final_result,
            validator_results=validator_results,
            total_duration_ms=total_duration_ms,
        )

    def _sort_validators(self) -> None:
        """Sort validators by priority (lower runs first).

        ``v.priority or 100`` would treat ``priority=0`` as falsy and silently
        sort that validator as if it had priority 100 — surprising behaviour
        for callers who set 0 to mean "run me first". Use an explicit
        ``is None`` check instead.
        """
        self._validators.sort(
            key=lambda v: v.priority if v.priority is not None else 100,
        )

    def _get_applicable_validators(
        self, tool_name: str
    ) -> list[NamedValidator]:
        """Get validators that apply to a specific tool."""
        result = []
        for validator in self._validators:
            # If no filter specified, validator applies to all tools
            if not validator.tool_filter or len(validator.tool_filter) == 0:
                result.append(validator)
            # Check if tool name is in the filter list
            elif tool_name in validator.tool_filter:
                result.append(validator)
        return result


def create_passthrough_validator() -> NamedValidator:
    """
    Create a simple validator that always allows.
    Useful as a placeholder or for testing.
    """
    return NamedValidator(
        name="passthrough",
        description="Allows all tool calls without validation",
        priority=1000,  # Run last
        validate=lambda ctx: ValidationResult(decision="allow"),
    )


def create_blocklist_validator(
    tool_names: list[str], reason: str = "Tool is blocked"
) -> NamedValidator:
    """
    Create a validator that denies specific tools.

    Args:
        tool_names: Names of tools to deny
        reason: Reason for denial
    """
    return NamedValidator(
        name="blocklist",
        description=f"Blocks tools: {', '.join(tool_names)}",
        priority=1,  # Run first
        tool_filter=tool_names,
        validate=lambda ctx: ValidationResult(
            decision="deny",
            reason=f"{reason}: {ctx.tool_name}",
        ),
    )


def create_allowlist_validator(
    tool_names: list[str], reason: str = "Tool is not in allowlist"
) -> NamedValidator:
    """
    Create a validator that only allows specific tools.

    Args:
        tool_names: Names of tools to allow
        reason: Reason for denial of other tools
    """
    tool_set = set(tool_names)

    def validate(ctx: ValidationContext) -> ValidationResult:
        if ctx.tool_name in tool_set:
            return ValidationResult(decision="allow")
        return ValidationResult(
            decision="deny",
            reason=f"{reason}: {ctx.tool_name}",
        )

    return NamedValidator(
        name="allowlist",
        description=f"Only allows tools: {', '.join(tool_names)}",
        priority=1,  # Run first
        validate=validate,
    )
