"""
CrewAI BaseTool integration for Veto.

Wraps CrewAI tools so every ``_run()`` and ``_arun()`` call is validated
through ``veto.guard()`` before execution.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import copy
import inspect
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Optional

from veto.core.interceptor import ToolCallDeniedError
from veto.types.config import ValidationResult
from veto.utils.id import generate_tool_call_id

if TYPE_CHECKING:
    from veto.core.veto import GuardResult, Veto

try:
    from crewai.tools import BaseTool  # type: ignore[import-not-found]
except ImportError as import_error:
    BaseTool = None
    _CREWAI_IMPORT_ERROR: Optional[ImportError] = import_error
else:
    _CREWAI_IMPORT_ERROR = None


def _require_crewai() -> None:
    if _CREWAI_IMPORT_ERROR is not None:
        raise ImportError(
            "crewai is required for this integration. "
            "Install it with: pip install crewai"
        ) from _CREWAI_IMPORT_ERROR


def _build_validation_result(guard_result: "GuardResult") -> ValidationResult:
    metadata: dict[str, Any] = {}
    if guard_result.rule_id is not None:
        metadata["rule_id"] = guard_result.rule_id
    if guard_result.severity is not None:
        metadata["severity"] = guard_result.severity
    if guard_result.approval_id is not None:
        metadata["approval_id"] = guard_result.approval_id

    return ValidationResult(
        decision="deny",
        reason=guard_result.reason or "Policy violation",
        metadata=metadata or None,
    )


def _raise_tool_denied(tool_name: str, guard_result: "GuardResult") -> None:
    raise ToolCallDeniedError(
        tool_name,
        generate_tool_call_id(),
        _build_validation_result(guard_result),
    )


def _extract_field_names(tool: Any) -> list[str]:
    args_schema = getattr(tool, "args_schema", None)
    if args_schema is None:
        return []

    model_fields = getattr(args_schema, "model_fields", None)
    if isinstance(model_fields, Mapping):
        return [str(field_name) for field_name in model_fields.keys()]

    pydantic_v1_fields = getattr(args_schema, "__fields__", None)
    if isinstance(pydantic_v1_fields, Mapping):
        return [str(field_name) for field_name in pydantic_v1_fields.keys()]

    return []


def _build_args_dict(tool: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
    field_names = _extract_field_names(tool)
    args_dict: dict[str, Any] = {}

    for index, value in enumerate(args):
        if index < len(field_names):
            args_dict[field_names[index]] = value
        else:
            args_dict[f"arg_{index}"] = value

    args_dict.update(kwargs)
    return args_dict


async def _guard_or_raise(veto: "Veto", tool_name: str, args_dict: dict[str, Any]) -> None:
    guard_result = await veto.guard(tool_name, args_dict)
    if guard_result.decision == "deny":
        _raise_tool_denied(tool_name, guard_result)


def _guard_or_raise_sync(veto: "Veto", tool_name: str, args_dict: dict[str, Any]) -> None:
    async def _run_guard() -> "GuardResult":
        return await veto.guard(tool_name, args_dict)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None and loop.is_running():
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            guard_result = pool.submit(asyncio.run, _run_guard()).result()
    else:
        guard_result = asyncio.run(_run_guard())

    if guard_result.decision == "deny":
        _raise_tool_denied(tool_name, guard_result)


def wrap_crewai_tools(veto: "Veto", tools: list[Any]) -> list[Any]:
    """
    Wrap CrewAI BaseTool instances with Veto validation.

    Args:
        veto: Initialized ``Veto`` instance.
        tools: CrewAI ``BaseTool`` instances.

    Returns:
        Wrapped ``BaseTool`` instances with guarded ``_run``/``_arun``.

    Raises:
        ImportError: If ``crewai`` is not installed.
    """
    _require_crewai()
    assert BaseTool is not None

    wrapped_tools: list[Any] = []

    for tool in tools:
        if not isinstance(tool, BaseTool):
            wrapped_tools.append(tool)
            continue

        wrapped_tool = copy.copy(tool)
        tool_name = getattr(wrapped_tool, "name", type(wrapped_tool).__name__)
        original_run = getattr(wrapped_tool, "_run", None)

        if callable(original_run):
            def _make_wrapped_run(
                current_tool: Any,
                current_tool_name: str,
                current_run: Any,
            ) -> Any:
                def wrapped_run(*args: Any, **kwargs: Any) -> Any:
                    args_dict = _build_args_dict(current_tool, args, kwargs)
                    _guard_or_raise_sync(veto, current_tool_name, args_dict)
                    return current_run(*args, **kwargs)

                return wrapped_run

            object.__setattr__(
                wrapped_tool,
                "_run",
                _make_wrapped_run(wrapped_tool, tool_name, original_run),
            )

        original_arun = getattr(wrapped_tool, "_arun", None)
        if callable(original_arun):
            def _make_wrapped_arun(
                current_tool: Any,
                current_tool_name: str,
                current_arun: Any,
            ) -> Any:
                async def wrapped_arun(*args: Any, **kwargs: Any) -> Any:
                    args_dict = _build_args_dict(current_tool, args, kwargs)
                    await _guard_or_raise(veto, current_tool_name, args_dict)
                    maybe_result = current_arun(*args, **kwargs)
                    if inspect.isawaitable(maybe_result):
                        return await maybe_result
                    return maybe_result

                return wrapped_arun

            object.__setattr__(
                wrapped_tool,
                "_arun",
                _make_wrapped_arun(wrapped_tool, tool_name, original_arun),
            )

        wrapped_tools.append(wrapped_tool)

    return wrapped_tools


__all__ = ["wrap_crewai_tools"]
