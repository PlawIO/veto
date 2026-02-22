"""
OpenAI Agents SDK guardrail adapters for Veto.

These factories bridge Veto validation into OpenAI Agents input/output/tool
guardrail hooks.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from veto.core.veto import Veto

try:
    from agents.guardrail import (
        GuardrailFunctionOutput,
        InputGuardrail,
        OutputGuardrail,
    )
    from agents.tool_guardrails import (
        ToolGuardrailFunctionOutput,
        ToolInputGuardrail,
        ToolOutputGuardrail,
    )
except ImportError as import_error:
    GuardrailFunctionOutput = None  # type: ignore[assignment]
    InputGuardrail = None  # type: ignore[assignment]
    OutputGuardrail = None  # type: ignore[assignment]
    ToolGuardrailFunctionOutput = None  # type: ignore[assignment]
    ToolInputGuardrail = None  # type: ignore[assignment]
    ToolOutputGuardrail = None  # type: ignore[assignment]
    _OPENAI_AGENTS_IMPORT_ERROR: Optional[ImportError] = import_error
else:
    _OPENAI_AGENTS_IMPORT_ERROR = None


def _require_openai_agents() -> None:
    if _OPENAI_AGENTS_IMPORT_ERROR is not None:
        raise ImportError(
            "openai-agents is required for this integration. "
            "Install it with: pip install openai-agents"
        ) from _OPENAI_AGENTS_IMPORT_ERROR


def _build_guardrail_output(
    *,
    tripwire_triggered: bool,
    output_info: Optional[dict[str, Any]] = None,
) -> Any:
    assert GuardrailFunctionOutput is not None

    kwargs: dict[str, Any] = {"tripwire_triggered": tripwire_triggered}
    if output_info is not None:
        kwargs["output_info"] = output_info

    # Older versions of openai-agents may require output_info explicitly.
    try:
        return GuardrailFunctionOutput(**kwargs)
    except TypeError:
        kwargs["output_info"] = output_info
        return GuardrailFunctionOutput(**kwargs)


def _resolve_tool_name(data: Any) -> str:
    context = getattr(data, "context", None)
    tool_name = getattr(context, "tool_name", None)
    if isinstance(tool_name, str) and tool_name:
        return tool_name
    return "unknown_tool"


def _parse_tool_arguments(data: Any) -> dict[str, Any]:
    context = getattr(data, "context", None)
    raw_arguments = getattr(context, "tool_arguments", None)
    if not isinstance(raw_arguments, str) or raw_arguments == "":
        return {}

    try:
        parsed = json.loads(raw_arguments)
    except json.JSONDecodeError:
        return {}

    if isinstance(parsed, dict):
        return parsed
    return {"value": parsed}


def create_veto_input_guardrail(veto: "Veto", name: Optional[str] = None) -> Any:
    """
    Create an OpenAI Agents ``InputGuardrail`` backed by ``veto.guard()``.
    """
    _require_openai_agents()
    assert InputGuardrail is not None

    guardrail_name = name or "VetoInputGuardrail"

    async def guardrail_function(ctx: Any, agent: Any, input_data: Any) -> Any:
        _ = ctx
        _ = agent
        result = await veto.guard("agent_input", {"input": input_data})

        if result.decision == "deny":
            return _build_guardrail_output(
                tripwire_triggered=True,
                output_info={"reason": result.reason},
            )

        return _build_guardrail_output(tripwire_triggered=False)

    return InputGuardrail(guardrail_function=guardrail_function, name=guardrail_name)


def create_veto_output_guardrail(veto: "Veto", name: Optional[str] = None) -> Any:
    """
    Create an OpenAI Agents ``OutputGuardrail`` backed by ``veto.validate_output()``.
    """
    _require_openai_agents()
    assert OutputGuardrail is not None

    guardrail_name = name or "VetoOutputGuardrail"

    async def guardrail_function(ctx: Any, agent: Any, output: Any) -> Any:
        _ = ctx
        _ = agent
        result = veto.validate_output("agent_output", str(output))

        if result.decision == "block":
            return _build_guardrail_output(
                tripwire_triggered=True,
                output_info={
                    "reason": result.reason,
                    "matched_rules": result.matched_rule_ids,
                },
            )

        return _build_guardrail_output(tripwire_triggered=False)

    return OutputGuardrail(guardrail_function=guardrail_function, name=guardrail_name)


def create_veto_tool_guardrails(
    veto: "Veto",
    name: Optional[str] = None,
) -> tuple[Any, Any]:
    """
    Create OpenAI Agents tool input/output guardrails backed by Veto.
    """
    _require_openai_agents()
    assert ToolInputGuardrail is not None
    assert ToolOutputGuardrail is not None
    assert ToolGuardrailFunctionOutput is not None

    input_name = f"{name}Input" if name else "VetoToolInputGuardrail"
    output_name = f"{name}Output" if name else "VetoToolOutputGuardrail"

    async def input_guardrail_function(data: Any) -> Any:
        tool_name = _resolve_tool_name(data)
        args = _parse_tool_arguments(data)
        result = await veto.guard(tool_name, args)

        if result.decision == "deny":
            reason = result.reason or "Policy violation"
            return ToolGuardrailFunctionOutput.reject_content(reason)

        return ToolGuardrailFunctionOutput.allow()

    async def output_guardrail_function(data: Any) -> Any:
        tool_name = _resolve_tool_name(data)
        result = veto.validate_output(tool_name, str(getattr(data, "output", None)))

        if result.decision == "block":
            reason = result.reason or "Policy violation"
            return ToolGuardrailFunctionOutput.reject_content(reason)

        return ToolGuardrailFunctionOutput.allow()

    return (
        ToolInputGuardrail(
            guardrail_function=input_guardrail_function,
            name=input_name,
        ),
        ToolOutputGuardrail(
            guardrail_function=output_guardrail_function,
            name=output_name,
        ),
    )
