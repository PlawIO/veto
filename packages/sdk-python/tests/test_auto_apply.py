"""Auto-apply policy pack tests for protect()."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from veto import ToolCallDeniedError, protect

protect_module = importlib.import_module("veto.core.protect")


class MockTool:
    def __init__(self, name: str, response: str = "ok"):
        self.name = name
        self.response = response

    async def handler(self, args: dict[str, object]) -> str:
        _ = args
        return self.response


@pytest.fixture(autouse=True)
def _reset_protect_cache() -> None:
    protect_module._reset_protect_cache_for_tests()
    yield
    protect_module._reset_protect_cache_for_tests()


@pytest.fixture
def isolated_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


async def test_auto_apply_financial_pack(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("transfer_funds")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"amount": 15000, "currency": "USD"})


async def test_auto_apply_browser_pack(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("navigate")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"url": "javascript:alert(1)"})


async def test_auto_apply_communication_pack(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("send_email")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler(
            {
                "to": [
                    "a@acme.com",
                    "b@acme.com",
                    "c@acme.com",
                    "d@acme.com",
                    "e@acme.com",
                    "f@acme.com",
                ],
                "subject": "status",
                "body": "hello",
            }
        )


async def test_auto_apply_deployment_pack(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("deploy")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"environment": "production"})


async def test_auto_apply_merges_multiple_packs(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect(
        [MockTool("transfer_funds"), MockTool("send_email"), MockTool("deploy")],
        log_level="silent",
    )

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"amount": 15000, "currency": "USD"})

    with pytest.raises(ToolCallDeniedError):
        await wrapped[1].handler({"to": ["x@acme.com"], "body": "password: hunter2"})

    with pytest.raises(ToolCallDeniedError):
        await wrapped[2].handler({"force": True, "environment": "staging"})


async def test_auto_apply_allow_all_when_no_match(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("unknown_tool", "allowed")], log_level="silent")

    assert await wrapped[0].handler({"anything": True}) == "allowed"


async def test_communication_blocks_credentials_in_body(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("send_email")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler(
            {
                "to": ["a@acme.com"],
                "subject": "credentials",
                "body": "api_key = sk_live_123",
            }
        )


async def test_communication_requires_approval_for_more_than_five_recipients(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("send_email")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler(
            {
                "to": [
                    "a@acme.com",
                    "b@acme.com",
                    "c@acme.com",
                    "d@acme.com",
                    "e@acme.com",
                    "f@acme.com",
                ],
                "subject": "team update",
                "body": "status",
            }
        )


async def test_deployment_requires_approval_for_production(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("deploy")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"env": "prod"})


async def test_deployment_blocks_force_flags(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("deploy")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"skip_checks": True, "environment": "staging"})


async def test_financial_requires_approval_for_15k_and_allows_5k(isolated_cwd):
    _ = isolated_cwd
    wrapped = await protect([MockTool("transfer_funds", "executed")], log_level="silent")

    with pytest.raises(ToolCallDeniedError):
        await wrapped[0].handler({"amount": 15000, "currency": "USD"})

    assert await wrapped[0].handler({"amount": 5000, "currency": "USD"}) == "executed"


async def test_auto_apply_prints_selected_packs_to_stderr(isolated_cwd, capsys: pytest.CaptureFixture[str]):
    _ = isolated_cwd

    await protect([MockTool("transfer_funds"), MockTool("send_email")], log_level="info")

    output = capsys.readouterr().err
    assert "[veto] Auto-applied policy packs: @veto/communication, @veto/financial" in output
    assert "Run 'npx veto test' for details." in output


async def test_auto_apply_stderr_suppressed_when_silent(isolated_cwd, capsys: pytest.CaptureFixture[str]):
    _ = isolated_cwd

    await protect([MockTool("transfer_funds")], log_level="silent")

    output = capsys.readouterr().err
    assert output == ""
