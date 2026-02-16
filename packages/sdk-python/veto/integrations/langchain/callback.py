"""
LangChain callback handler for Veto observability.

Provides a ``BaseCallbackHandler`` subclass that logs tool start, end,
and error events. Callbacks are observational and cannot block execution.
Use alongside middleware for audit logging, metrics, or tracing.

Usage::

    from veto.integrations.langchain import VetoCallbackHandler

    handler = VetoCallbackHandler(
        on_tool_start=lambda name, inp: print(f"Started: {name}"),
        on_tool_end=lambda output: print(f"Done: {output}"),
    )

    result = await agent.invoke(
        {"messages": [{"role": "user", "content": "Hello"}]},
        config={"callbacks": [handler]},
    )
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional
from uuid import UUID

logger = logging.getLogger("veto.integrations.langchain")


class VetoCallbackHandler:
    """
    Observational callback handler for LangChain tool events.

    Compatible with LangChain's callback system. Fires on tool
    start/end/error for logging and metrics. Does not block execution.

    Args:
        on_tool_start: ``(tool_name: str, input_str: str) -> None``
        on_tool_end: ``(output: str) -> None``
        on_tool_error: ``(error: BaseException) -> None``
    """

    name = "VetoCallbackHandler"

    def __init__(
        self,
        *,
        on_tool_start: Optional[Callable[..., Any]] = None,
        on_tool_end: Optional[Callable[..., Any]] = None,
        on_tool_error: Optional[Callable[..., Any]] = None,
    ) -> None:
        self._on_tool_start = on_tool_start
        self._on_tool_end = on_tool_end
        self._on_tool_error = on_tool_error

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        name = serialized.get("name", "unknown")
        logger.debug("Tool started: %s", name)
        if self._on_tool_start is not None:
            self._on_tool_start(name, input_str)

    def on_tool_end(
        self,
        output: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        logger.debug("Tool finished")
        if self._on_tool_end is not None:
            self._on_tool_end(output)

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        logger.debug("Tool error: %s", error)
        if self._on_tool_error is not None:
            self._on_tool_error(error)
