"""
LangGraph ToolNode wrapper for Veto.

Validates every tool call from the model's response before delegating to
the actual ``ToolNode`` for execution. Denied calls return a ``ToolMessage``
with the denial reason instead of executing the tool.

Usage::

    from langgraph.prebuilt import ToolNode
    from veto import Veto, VetoOptions
    from veto.integrations.langchain import create_veto_tool_node

    veto = await Veto.init(VetoOptions(api_key="your-key"))
    tool_node = ToolNode([search_tool, email_tool])
    veto_tool_node = create_veto_tool_node(veto, tool_node)

    # Use veto_tool_node in your LangGraph graph
    graph = StateGraph(MessagesState)
    graph.add_node("tools", veto_tool_node)
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:
    from veto.core.veto import Veto

from veto.types.tool import ToolCall
from veto.utils.id import generate_tool_call_id

logger = logging.getLogger("veto.integrations.langchain")


def create_veto_tool_node(
    veto: "Veto",
    tool_node: Any,
    *,
    on_allow: Optional[Callable[..., Any]] = None,
    on_deny: Optional[Callable[..., Any]] = None,
) -> Callable[..., Any]:
    """
    Wrap a LangGraph ``ToolNode`` with Veto validation.

    Returns an async function with the same signature as a LangGraph node
    that validates each tool call in the last ``AIMessage`` before
    delegating to the real ``ToolNode``.

    Args:
        veto: An initialized ``Veto`` instance.
        tool_node: A LangGraph ``ToolNode`` instance.
        on_allow: Optional callback ``(tool_name, args) -> None``.
        on_deny: Optional callback ``(tool_name, args, reason) -> None``.

    Returns:
        An async function usable as a LangGraph node.
    """

    async def validated_tool_node(state: dict[str, Any]) -> dict[str, Any]:
        messages = state.get("messages", [])
        if not messages:
            return await tool_node.ainvoke(state)

        last_message = messages[-1]
        tool_calls = getattr(last_message, "tool_calls", None) or []

        if not tool_calls:
            return await tool_node.ainvoke(state)

        for tc in tool_calls:
            if isinstance(tc, dict):
                name = tc.get("name", "")
                args = tc.get("args", {})
                call_id = tc.get("id") or generate_tool_call_id()
            else:
                name = getattr(tc, "name", "")
                args = getattr(tc, "args", {})
                call_id = getattr(tc, "id", None) or generate_tool_call_id()

            result = await veto._validate_tool_call(
                ToolCall(
                    id=call_id,
                    name=name,
                    arguments=args if isinstance(args, dict) else {},
                )
            )

            if not result.allowed:
                reason = result.validation_result.reason or "Policy violation"
                logger.info("BLOCKED %s: %s", name, reason)

                if on_deny is not None:
                    await on_deny(name, args, reason)

                try:
                    from langchain_core.messages import ToolMessage
                    return {
                        "messages": [
                            ToolMessage(
                                content=f"Tool call denied by Veto: {reason}",
                                tool_call_id=t.get("id", call_id) if isinstance(t, dict) else getattr(t, "id", call_id),
                            )
                            for t in tool_calls
                        ]
                    }
                except ImportError:
                    return {
                        "messages": [
                            {
                                "content": f"Tool call denied by Veto: {reason}",
                                "tool_call_id": t.get("id", call_id) if isinstance(t, dict) else getattr(t, "id", call_id),
                            }
                            for t in tool_calls
                        ]
                    }

            logger.info("ALLOWED %s", name)
            if on_allow is not None:
                await on_allow(name, args)

        return await tool_node.ainvoke(state)

    return validated_tool_node
