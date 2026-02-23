"""
PydanticAI integration for Veto.

Provides two helpers:

    - ``wrap_pydanticai_tool``
    - ``create_veto_tool_decorator``
"""

from veto.integrations.pydanticai.integration import (
    create_veto_tool_decorator,
    wrap_pydanticai_tool,
)

__all__ = [
    "wrap_pydanticai_tool",
    "create_veto_tool_decorator",
]
