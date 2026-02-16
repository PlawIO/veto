"""
LangChain integration for Veto.

Provides middleware, callback handlers, and LangGraph ToolNode wrappers
that validate every tool call through Veto before execution.

Available components:

    - ``VetoMiddleware``: Class-based middleware for ``create_agent``
    - ``veto_wrap_tool_call``: Decorator-style middleware for ``create_agent``
    - ``create_veto_tool_node``: LangGraph ToolNode wrapper
    - ``VetoCallbackHandler``: Observational callback handler for logging

Usage with ``create_agent``::

    from langchain.agents import create_agent
    from veto import Veto, VetoOptions
    from veto.integrations.langchain import VetoMiddleware

    veto = await Veto.init(VetoOptions(api_key="your-key"))

    agent = create_agent(
        model="openai:gpt-4o",
        tools=[search_tool, email_tool],
        middleware=[VetoMiddleware(veto)],
    )

Usage with LangGraph::

    from veto.integrations.langchain import create_veto_tool_node

    veto_tool_node = create_veto_tool_node(veto, tool_node)
"""

from veto.integrations.langchain.middleware import (
    VetoMiddleware,
    veto_wrap_tool_call,
)
from veto.integrations.langchain.tool_node import create_veto_tool_node
from veto.integrations.langchain.callback import VetoCallbackHandler

__all__ = [
    "VetoMiddleware",
    "veto_wrap_tool_call",
    "create_veto_tool_node",
    "VetoCallbackHandler",
]
