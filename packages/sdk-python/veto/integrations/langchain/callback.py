"""
LangChain callback handler for Veto observability.

Provides a ``BaseCallbackHandler`` subclass that logs tool start, end,
and error events. Callbacks are observational and cannot block execution.
Use alongside middleware for audit logging, metrics, or tracing.

Usage::

    from veto.integrations.langchain import VetoCallbackHandler

    handler = VetoCallbackHandler(
        on_tool_start=lambda name, inp: print(f"Started: {name}"),
        on_tool_end=lambda name, output: print(f"Done: {name}: {output}"),
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

try:
    from langchain_core.callbacks import BaseCallbackHandler as _Base
except ImportError:
    _Base = object  # type: ignore[misc,assignment]

logger = logging.getLogger("veto.integrations.langchain")


class VetoCallbackHandler(_Base):  # type: ignore[misc]
    """
    Observational callback handler for LangChain tool events.

    Inherits from ``BaseCallbackHandler`` (when ``langchain_core`` is
    installed) so LangChain's ``CallbackManager`` recognises it via
    ``isinstance`` checks. Falls back to plain ``object`` when the
    dependency is absent.

    Fires on tool start/end/error for logging and metrics. Does not
    block execution.

    Note:
        LangChain's ``BaseCallbackHandler`` methods are **synchronous**.
        All user callbacks passed here must be synchronous functions.
        For async callbacks, use ``VetoMiddleware`` or
        ``create_veto_tool_node`` which support both sync and async
        via ``inspect.isawaitable()``.

    Args:
        on_tool_start: Sync callback ``(tool_name: str, input_str: str) -> None``.
        on_tool_end: Sync callback ``(tool_name: str, output: str) -> None``.
        on_tool_error: Sync callback ``(tool_name: str, error: BaseException) -> None``.
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
        self._tool_names: dict[UUID, str] = {}

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
        self._tool_names[run_id] = name
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
        name = self._tool_names.pop(run_id, "")
        logger.debug("Tool finished: %s", name)
        if self._on_tool_end is not None:
            self._on_tool_end(name, output)

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        name = self._tool_names.pop(run_id, "")
        logger.debug("Tool error: %s (%s)", name, error)
        if self._on_tool_error is not None:
            self._on_tool_error(name, error)
