"""
Tests for PydanticAI integration wrappers.
"""

from __future__ import annotations

import importlib
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from veto.core.interceptor import ToolCallDeniedError

MODULE_PATH = "veto.integrations.pydanticai.integration"
PACKAGE_PATH = "veto.integrations.pydanticai"


def _reset_pydanticai_integration_modules() -> None:
    sys.modules.pop(MODULE_PATH, None)
    sys.modules.pop(PACKAGE_PATH, None)


def _load_pydanticai_integration() -> types.ModuleType:
    _reset_pydanticai_integration_modules()
    return importlib.import_module(MODULE_PATH)


def _install_fake_pydanticai(monkeypatch: pytest.MonkeyPatch) -> None:
    pydantic_ai_module = types.ModuleType("pydantic_ai")
    pydantic_ai_module.__version__ = "0.0.0"
    monkeypatch.setitem(sys.modules, "pydantic_ai", pydantic_ai_module)


def _make_guard_result(
    decision: str,
    reason: str | None = None,
    *,
    shadow: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        decision=decision,
        reason=reason,
        rule_id=None,
        severity=None,
        approval_id=None,
        shadow=shadow if shadow else None,
    )


class TestPydanticAIIntegration:
    async def test_wrap_pydanticai_tool_validates_before_calling_handler(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install_fake_pydanticai(monkeypatch)
        integration = _load_pydanticai_integration()
        events: list[str] = []

        async def transfer_funds(amount: float, to_account: str) -> str:
            events.append("handler")
            return f"Transferred ${amount} to {to_account}"

        async def guard(tool_name: str, args_dict: dict[str, object]) -> SimpleNamespace:
            events.append("guard")
            assert tool_name == "transfer_funds"
            assert args_dict == {"amount": 200.0, "to_account": "ACC-001"}
            return _make_guard_result("allow")

        veto = SimpleNamespace(guard=AsyncMock(side_effect=guard))
        wrapped_handler = integration.wrap_pydanticai_tool(
            veto,
            "transfer_funds",
            transfer_funds,
        )

        result = await wrapped_handler(amount=200.0, to_account="ACC-001")

        assert result == "Transferred $200.0 to ACC-001"
        assert events == ["guard", "handler"]
        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {"amount": 200.0, "to_account": "ACC-001"},
        )

    async def test_denied_pydanticai_tool_call_raises_tool_call_denied_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install_fake_pydanticai(monkeypatch)
        integration = _load_pydanticai_integration()

        async def transfer_funds(amount: float, to_account: str) -> str:
            return f"Transferred ${amount} to {to_account}"

        veto = SimpleNamespace(
            guard=AsyncMock(
                return_value=_make_guard_result(
                    "deny",
                    "Transfer amount violates policy",
                )
            )
        )
        wrapped_handler = integration.wrap_pydanticai_tool(
            veto,
            "transfer_funds",
            transfer_funds,
        )

        with pytest.raises(ToolCallDeniedError) as exc_info:
            await wrapped_handler(amount=5000.0, to_account="ACC-001")

        assert exc_info.value.tool_name == "transfer_funds"
        assert exc_info.value.reason == "Transfer amount violates policy"
        assert exc_info.value.validation_result.reason == "Transfer amount violates policy"
        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {"amount": 5000.0, "to_account": "ACC-001"},
        )

    async def test_shadow_denied_pydanticai_tool_call_does_not_raise(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install_fake_pydanticai(monkeypatch)
        integration = _load_pydanticai_integration()

        async def transfer_funds(amount: float, to_account: str) -> str:
            return f"Transferred ${amount} to {to_account}"

        veto = SimpleNamespace(
            guard=AsyncMock(
                return_value=_make_guard_result(
                    "deny",
                    "Would block in strict",
                    shadow=True,
                )
            )
        )
        wrapped_handler = integration.wrap_pydanticai_tool(
            veto,
            "transfer_funds",
            transfer_funds,
        )

        result = await wrapped_handler(amount=5000.0, to_account="ACC-001")
        assert result == "Transferred $5000.0 to ACC-001"

    async def test_allowed_pydanticai_tool_call_returns_handler_result(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install_fake_pydanticai(monkeypatch)
        integration = _load_pydanticai_integration()

        async def get_balance(account_id: str) -> str:
            return f"Balance for {account_id}: $5,000"

        veto = SimpleNamespace(guard=AsyncMock(return_value=_make_guard_result("allow")))
        wrapped_handler = integration.wrap_pydanticai_tool(
            veto,
            "get_balance",
            get_balance,
        )

        result = await wrapped_handler(account_id="ACC-001")

        assert result == "Balance for ACC-001: $5,000"
        veto.guard.assert_awaited_once_with(
            "get_balance",
            {"account_id": "ACC-001"},
        )

    async def test_create_veto_tool_decorator_works_as_decorator(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install_fake_pydanticai(monkeypatch)
        integration = _load_pydanticai_integration()

        veto = SimpleNamespace(guard=AsyncMock(return_value=_make_guard_result("allow")))
        decorator = integration.create_veto_tool_decorator(veto, "transfer_funds")

        @decorator
        async def transfer_funds(amount: float, to_account: str) -> str:
            return f"Transferred ${amount} to {to_account}"

        result = await transfer_funds(amount=75.0, to_account="ACC-100")

        assert result == "Transferred $75.0 to ACC-100"
        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {"amount": 75.0, "to_account": "ACC-100"},
        )

    async def test_decorator_builds_args_dict_from_function_kwargs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _install_fake_pydanticai(monkeypatch)
        integration = _load_pydanticai_integration()

        veto = SimpleNamespace(guard=AsyncMock(return_value=_make_guard_result("allow")))

        @integration.create_veto_tool_decorator(veto, "transfer_funds")
        async def transfer_funds(amount: float, to_account: str, reason: str) -> str:
            return f"Transferred ${amount} to {to_account} ({reason})"

        await transfer_funds(
            amount=125.0,
            to_account="ACC-555",
            reason="invoice payment",
        )

        veto.guard.assert_awaited_once_with(
            "transfer_funds",
            {
                "amount": 125.0,
                "to_account": "ACC-555",
                "reason": "invoice payment",
            },
        )
