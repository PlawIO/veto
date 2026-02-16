"""
LangChain middleware integration for Veto.

Provides both class-based and decorator-style middleware that intercepts
every tool call in a LangChain agent and validates it through Veto
before execution.

The middleware works with LangChain v1's ``create_agent`` API. When a tool
call is denied, a ``ToolMessage`` is returned to the model indicating the
denial instead of executing the tool.

Usage::

    from langchain.agents import create_agent
    from veto import Veto, VetoOptions
    from veto.integrations.langchain import VetoMiddleware

    veto = await Veto.init(VetoOptions(api_key="your-key"))

    agent = create_agent(
        model="openai:gpt-4o",
        tools=[search_tool, email_tool],
        middleware=[VetoMiddleware(veto)],
    )
"""

from __future__ import annotations

import inspect
import logging
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:
    from veto.core.veto import Veto

from veto.core.interceptor import ToolCallDeniedError
from veto.types.tool import ToolCall
from veto.utils.id import generate_tool_call_id

logger = logging.getLogger("veto.integrations.langchain")


class VetoMiddleware:
    """
    Class-based LangChain middleware that validates tool calls through Veto.

    Compatible with the ``middleware`` parameter of ``create_agent`` from
    ``langchain``. Implements ``wrap_tool_call`` to intercept tool
    execution and validate against Veto policies.

    Args:
        veto: An initialized ``Veto`` instance.
        on_allow: Optional callback ``(tool_name, args) -> None``.
        on_deny: Optional callback ``(tool_name, args, reason) -> None``.
        throw_on_deny: If True, raises ``ToolCallDeniedError`` instead of
            returning a ``ToolMessage``. Defaults to False.

    Example::

        from veto.integrations.langchain import VetoMiddleware

        middleware = VetoMiddleware(
            veto,
            on_deny=lambda name, args, reason: print(f"Blocked {name}: {reason}"),
        )

        agent = create_agent(
            model="openai:gpt-4o",
            tools=[search_tool],
            middleware=[middleware],
        )
    """

    name = "VetoGuardrail"

    def __init__(
        self,
        veto: "Veto",
        *,
        on_allow: Optional[Callable[..., Any]] = None,
        on_deny: Optional[Callable[..., Any]] = None,
        throw_on_deny: bool = False,
    ) -> None:
        self._veto = veto
        self._on_allow = on_allow
        self._on_deny = on_deny
        self._throw_on_deny = throw_on_deny

    async def wrap_tool_call(
        self,
        request: Any,
        handler: Callable[..., Any],
    ) -> Any:
        """Validate the tool call, then pass through or deny."""
        tc = request.tool_call if hasattr(request, "tool_call") else request.get("tool_call", {})
        if isinstance(tc, dict):
            tool_name = tc.get("name", "")
            args = tc.get("args", {})
            call_id = tc.get("id") or generate_tool_call_id()
        else:
            tool_name = getattr(tc, "name", "")
            args = getattr(tc, "args", {})
            call_id = getattr(tc, "id", None) or generate_tool_call_id()

        result = await self._veto.validate_tool_call(
            ToolCall(
                id=call_id,
                name=tool_name,
                arguments=args if isinstance(args, dict) else {},
            )
        )

        if not result.allowed:
            reason = result.validation_result.reason or "Policy violation"
            logger.info("BLOCKED %s: %s", tool_name, reason)

            if self._on_deny is not None:
                ret = self._on_deny(tool_name, args, reason)
                if inspect.isawaitable(ret):
                    await ret

            if self._throw_on_deny:
                raise ToolCallDeniedError(
                    tool_name,
                    call_id,
                    result.validation_result,
                )

            try:
                from langchain_core.messages import ToolMessage
                return ToolMessage(
                    content=f"Tool call denied by Veto: {reason}",
                    tool_call_id=call_id,
                )
            except ImportError:
                return {"content": f"Tool call denied by Veto: {reason}", "tool_call_id": call_id}

        logger.info("ALLOWED %s", tool_name)
        if self._on_allow is not None:
            ret = self._on_allow(tool_name, args)
            if inspect.isawaitable(ret):
                await ret

        # Forward modified arguments when Veto has sanitized/changed them
        if result.final_arguments and result.final_arguments != args:
            if isinstance(tc, dict):
                modified_tc = {**tc, "args": result.final_arguments}
            else:
                modified_tc = type(tc)(**{**tc.__dict__, "args": result.final_arguments})

            if hasattr(request, "tool_call"):
                modified_request = type(request)(**{**request.__dict__, "tool_call": modified_tc})
            elif isinstance(request, dict):
                modified_request = {**request, "tool_call": modified_tc}
            else:
                modified_request = request
            return await handler(modified_request)

        return await handler(request)


def veto_wrap_tool_call(
    veto: "Veto",
    *,
    on_allow: Optional[Callable[..., Any]] = None,
    on_deny: Optional[Callable[..., Any]] = None,
    throw_on_deny: bool = False,
) -> Callable[..., Any]:
    """
    Create a decorator-style ``wrap_tool_call`` middleware function.

    This is an alternative to ``VetoMiddleware`` for users who prefer
    the decorator API over class-based middleware.

    Usage::

        from veto.integrations.langchain import veto_wrap_tool_call

        agent = create_agent(
            model="openai:gpt-4o",
            tools=[search_tool],
            middleware=[{"name": "veto", "wrapToolCall": veto_wrap_tool_call(veto)}],
        )
    """
    mw = VetoMiddleware(
        veto, on_allow=on_allow, on_deny=on_deny, throw_on_deny=throw_on_deny
    )
    return mw.wrap_tool_call
