"""
PydanticAI function-wrapper integration for Veto.

PydanticAI tools are plain async functions, so this integration provides
helpers for wrapping async handlers and decorators with ``veto.guard()``.
"""

from __future__ import annotations

import inspect
from functools import wraps
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional, TypeVar, cast

from veto.core.interceptor import ToolCallDeniedError
from veto.types.config import ValidationResult
from veto.utils.id import generate_tool_call_id

if TYPE_CHECKING:
    from veto.core.veto import GuardResult, Veto

try:
    import pydantic_ai as _pydantic_ai  # type: ignore[import-not-found]
except ImportError as import_error:
    _PYDANTICAI_IMPORT_ERROR: Optional[ImportError] = import_error
else:
    _PYDANTICAI_IMPORT_ERROR = None

HandlerT = TypeVar("HandlerT", bound=Callable[..., Awaitable[Any]])


def _ensure_pydanticai_compatibility() -> None:
    if _PYDANTICAI_IMPORT_ERROR is not None:
        return
    _ = getattr(_pydantic_ai, "__name__", "pydantic_ai")


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


def _build_args_dict(handler: Callable[..., Awaitable[Any]], *args: Any, **kwargs: Any) -> dict[str, Any]:
    signature = inspect.signature(handler)
    bound = signature.bind_partial(*args, **kwargs)
    bound.apply_defaults()
    return dict(bound.arguments)


async def _guard_or_raise(veto: "Veto", tool_name: str, args_dict: dict[str, Any]) -> None:
    guard_result = await veto.guard(tool_name, args_dict)
    if guard_result.decision == "deny":
        raise ToolCallDeniedError(
            tool_name,
            generate_tool_call_id(),
            _build_validation_result(guard_result),
        )


def wrap_pydanticai_tool(
    veto: "Veto",
    tool_name: str,
    handler: HandlerT,
) -> HandlerT:
    """
    Wrap a PydanticAI async tool handler with Veto validation.

    Args:
        veto: Initialized ``Veto`` instance.
        tool_name: Tool name to validate against.
        handler: Original async tool handler.

    Returns:
        Wrapped async handler.
    """
    _ensure_pydanticai_compatibility()

    if not inspect.iscoroutinefunction(handler):
        raise TypeError("PydanticAI tool handler must be an async function")

    @wraps(handler)
    async def wrapped_handler(*args: Any, **kwargs: Any) -> Any:
        args_dict = _build_args_dict(handler, *args, **kwargs)
        await _guard_or_raise(veto, tool_name, args_dict)
        return await handler(*args, **kwargs)

    return cast(HandlerT, wrapped_handler)


def create_veto_tool_decorator(
    veto: "Veto",
    tool_name: str,
) -> Callable[[HandlerT], HandlerT]:
    """
    Create a decorator that applies Veto validation to async tool handlers.
    """
    _ensure_pydanticai_compatibility()

    def decorator(handler: HandlerT) -> HandlerT:
        if not inspect.iscoroutinefunction(handler):
            raise TypeError("Veto tool decorator can only wrap async functions")
        wrapped = wrap_pydanticai_tool(veto, tool_name, handler)
        return cast(HandlerT, wrapped)

    return decorator


__all__ = [
    "wrap_pydanticai_tool",
    "create_veto_tool_decorator",
]
