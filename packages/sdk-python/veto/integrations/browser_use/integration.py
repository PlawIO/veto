"""
Browser-Use integration for Veto.

Wraps browser-use's ``Tools`` class so that every browser action is validated
through Veto Cloud before execution. Tool schemas are automatically synced
to Veto Cloud for policy configuration.

The integration works by subclassing ``Tools`` and overriding ``act()`` —
the single dispatch point for all browser actions (navigate, click, input,
scroll, search, extract, done, etc.). Each action is validated against
Veto Cloud policies before the original implementation runs.

Usage::

    from veto import Veto, VetoOptions
    from veto.integrations.browser_use import wrap_browser_use

    veto = await Veto.init(VetoOptions(api_key="your-key"))
    tools = await wrap_browser_use(veto)

    # Pass ``tools`` to a browser-use Agent — everything else works as normal.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from veto.core.veto import Veto

from veto.types.tool import ToolCall
from veto.utils.id import generate_tool_call_id

logger = logging.getLogger("veto.integrations.browser_use")

# Default set of browser-use actions that are validated through Veto.
# These names match the keys in the browser-use action registry.
DEFAULT_VALIDATED_ACTIONS: set[str] = {
    "navigate",
    "search",
    "click",
    "input",
    "extract",
    "scroll",
    "done",
}


async def wrap_browser_use(
    veto: "Veto",
    *,
    validated_actions: Optional[set[str]] = None,
    on_allow: Any = None,
    on_deny: Any = None,
) -> Any:
    """
    Create a browser-use ``Tools`` instance with Veto guardrails.

    Returns a drop-in replacement for ``browser_use.tools.service.Tools``
    where every browser action in *validated_actions* is validated through
    Veto Cloud before execution. Actions not in the set pass through
    unvalidated.

    Tool schemas are automatically extracted from the browser-use action
    registry and synced to Veto Cloud, so policies can be configured
    immediately via the Veto dashboard.

    Args:
        veto:
            An initialized ``Veto`` instance.
        validated_actions:
            Set of action names to validate. Defaults to
            ``{"navigate", "search", "click", "input", "extract",
            "scroll", "done"}``.  Pass a custom set to validate
            only specific actions.
        on_allow:
            Optional async callback ``(action_name: str, params: dict) -> None``
            called when an action is allowed by Veto.
        on_deny:
            Optional async callback
            ``(action_name: str, params: dict, reason: str) -> None``
            called when an action is denied by Veto.

    Returns:
        A ``Tools`` instance with Veto validation injected into ``act()``.

    Raises:
        ImportError: If ``browser-use`` is not installed.

    Example::

        from veto import Veto, VetoOptions
        from veto.integrations.browser_use import wrap_browser_use
        from browser_use import Agent, BrowserSession
        from langchain_google_genai import ChatGoogleGenerativeAI

        veto = await Veto.init(VetoOptions(api_key="your-key"))
        tools = await wrap_browser_use(veto)

        agent = Agent(
            task="Search DuckDuckGo for 'best laptops 2025'",
            llm=ChatGoogleGenerativeAI(model="gemini-2.0-flash"),
            tools=tools,
            browser_session=BrowserSession(),
        )
        await agent.run()
    """
    try:
        from browser_use.tools.service import Tools
        from browser_use.agent.views import ActionResult
    except ImportError as exc:
        raise ImportError(
            "browser-use is required for this integration. "
            "Install it with: pip install browser-use"
        ) from exc

    actions_to_validate = validated_actions or DEFAULT_VALIDATED_ACTIONS

    class VetoTools(Tools):  # type: ignore[misc]
        """Browser-use Tools subclass with Veto validation on ``act()``."""

        async def act(
            self,
            action: Any,
            browser_session: Any,
            **kwargs: Any,
        ) -> Any:
            """
            Validate *action* through Veto Cloud, then execute it.

            Actions whose name is in *validated_actions* are sent to
            Veto Cloud for policy evaluation. Denied actions return an
            ``ActionResult`` with an error message instead of executing.
            """
            # Extract action name and params from the Pydantic model.
            # browser-use actions are modeled as a union where exactly
            # one field is set — the field name is the action name.
            action_dict = action.model_dump(exclude_unset=True)
            action_name = next(iter(action_dict), None)
            params = action_dict.get(action_name, {}) if action_name else {}

            if action_name and action_name in actions_to_validate:
                try:
                    arguments = params if isinstance(params, dict) else {"value": params}
                    result = await veto.validate_tool_call(
                        ToolCall(
                            id=generate_tool_call_id(),
                            name=action_name,
                            arguments=arguments,
                        )
                    )

                    if not result.allowed:
                        reason = result.validation_result.reason or "Policy violation"

                        logger.info("BLOCKED %s: %s", action_name, reason)

                        if on_deny is not None:
                            await on_deny(action_name, params, reason)

                        return ActionResult(
                            error=f"Action blocked by Veto: {reason}",
                        )
                    else:
                        logger.info("ALLOWED %s", action_name)

                        if on_allow is not None:
                            await on_allow(action_name, params)

                except Exception as e:
                    logger.error("Error validating %s: %s", action_name, e)
                    return ActionResult(
                        error=f"Veto validation error: {e}",
                    )

            return await super().act(action, browser_session, **kwargs)

    # Instantiate the wrapped Tools
    tools = VetoTools()

    # Sync tool schemas to Veto Cloud.
    # browser-use's RegisteredAction has (name, description, param_model).
    # Veto's _register_tools_with_cloud() expects objects with
    # (name, description, args_schema) — SimpleNamespace bridges the gap.
    actions = tools.registry.registry.actions.values()
    shims = [
        SimpleNamespace(
            name=a.name,
            description=a.description,
            args_schema=a.param_model,
        )
        for a in actions
    ]
    await veto._register_tools_with_cloud(shims)

    logger.info("Registered %d browser-use tools with Veto Cloud", len(shims))

    return tools
