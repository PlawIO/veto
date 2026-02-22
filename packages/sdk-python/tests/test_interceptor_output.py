"""
Tests for interceptor output validation integration.
"""

from __future__ import annotations

from veto.core.interceptor import Interceptor, InterceptorOptions
from veto.core.output_validator import OutputValidationResult
from veto.core.validator import ValidationEngine, ValidationEngineOptions
from veto.types.config import NamedValidator, ValidationContext, ValidationResult
from veto.types.tool import ExecutableTool, ToolCall
from veto.utils.logger import create_logger


class _AllowOutputValidator:
    def validate(self, tool_name: str, output: object) -> OutputValidationResult:
        _ = tool_name
        _ = output
        return OutputValidationResult(
            decision="allow",
            output={"time": "[REDACTED]"},
            matched_rule_ids=["redact-time"],
            redactions=1,
        )


class _BlockOutputValidator:
    def validate(self, tool_name: str, output: object) -> OutputValidationResult:
        _ = tool_name
        _ = output
        return OutputValidationResult(
            decision="block",
            output=None,
            reason="Output contains sensitive data",
            matched_rule_ids=["block-sensitive"],
            redactions=0,
        )


def _build_engine() -> ValidationEngine:
    logger = create_logger("silent")
    engine = ValidationEngine(
        ValidationEngineOptions(
            logger=logger,
            default_decision="allow",
        )
    )

    def allow_all(_: ValidationContext) -> ValidationResult:
        return ValidationResult(decision="allow")

    engine.add_validator(
        NamedValidator(
            name="allow-all",
            validate=allow_all,
            priority=1,
        )
    )
    return engine


class TestInterceptorOutputValidation:
    async def test_intercept_and_execute_transforms_output(self) -> None:
        logger = create_logger("silent")
        interceptor = Interceptor(
            InterceptorOptions(
                logger=logger,
                validation_engine=_build_engine(),
                output_validator=_AllowOutputValidator(),
            )
        )

        call = ToolCall(
            id="call-1",
            name="get_time",
            arguments={},
        )
        tools = [
            ExecutableTool(
                name="get_time",
                input_schema={"type": "object"},
                handler=lambda _: {"time": "12:00"},
            )
        ]

        result = await interceptor.intercept_and_execute(call, tools)
        assert result.is_error is False
        assert result.content == {"time": "[REDACTED]"}

    async def test_intercept_and_execute_blocks_output(self) -> None:
        logger = create_logger("silent")
        interceptor = Interceptor(
            InterceptorOptions(
                logger=logger,
                validation_engine=_build_engine(),
                output_validator=_BlockOutputValidator(),
            )
        )

        call = ToolCall(
            id="call-2",
            name="get_secret",
            arguments={},
        )
        tools = [
            ExecutableTool(
                name="get_secret",
                input_schema={"type": "object"},
                handler=lambda _: {"secret": "abc"},
            )
        ]

        result = await interceptor.intercept_and_execute(call, tools)
        assert result.is_error is True
        assert result.content == {
            "error": "Tool output blocked",
            "reason": "Output contains sensitive data",
        }
