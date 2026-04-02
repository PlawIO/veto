"""
Tests for Veto core class.
"""

import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from veto import Veto, VetoOptions, ApprovalTimeoutError
from veto.cloud.client import VetoCloudClient
from veto.cloud.types import ValidationResponse, ToolRegistrationResponse, ApprovalData
from veto.types.config import ValidationContext, ValidationResult


@pytest.fixture(autouse=True)
async def close_initialized_clients(monkeypatch: pytest.MonkeyPatch):
    """Close real cloud clients created by Veto.init during each test."""
    original_init = Veto.init.__func__
    created_clients = []

    async def tracked_init(cls, options=None):
        veto = await original_init(cls, options)
        created_clients.append(veto._cloud_client)
        return veto

    monkeypatch.setattr(Veto, "init", classmethod(tracked_init))

    yield

    for client in created_clients:
        await client.close()


@pytest.fixture
def mock_cloud_client():
    """Create a mock cloud client for testing."""
    client = MagicMock(spec=VetoCloudClient)
    client._base_url = "https://api.runveto.com"
    client._api_key = "test-key"

    # Mock register_tools to return success
    client.register_tools = AsyncMock(
        return_value=ToolRegistrationResponse(
            success=True,
            registered_tools=["test_tool"],
        )
    )

    # Mock validate to allow by default
    client.validate = AsyncMock(
        return_value=ValidationResponse(
            decision="allow",
            reason="Allowed by mock",
        )
    )

    return client


class TestVetoInit:
    """Tests for Veto.init() method."""

    async def test_init_without_api_key(self):
        """Should initialize even without API key (with warning)."""
        # Clear any existing API key
        old_key = os.environ.pop("VETO_API_KEY", None)

        try:
            veto = await Veto.init(VetoOptions(log_level="silent"))
            assert veto is not None
            assert isinstance(veto, Veto)
        finally:
            if old_key:
                os.environ["VETO_API_KEY"] = old_key

    async def test_init_with_api_key(self):
        """Should initialize with API key from options."""
        veto = await Veto.init(
            VetoOptions(
                api_key="test-api-key",
                log_level="silent",
            )
        )
        assert veto is not None
        assert veto._cloud_client._api_key == "test-api-key"

    async def test_init_with_custom_base_url(self):
        """Should use custom base URL when provided."""
        veto = await Veto.init(
            VetoOptions(
                api_key="test-key",
                base_url="https://custom.veto.dev",
                log_level="silent",
            )
        )
        assert veto._cloud_client._base_url == "https://custom.veto.dev"

    async def test_init_from_env_var(self):
        """Should use API key from environment variable."""
        old_key = os.environ.get("VETO_API_KEY")
        os.environ["VETO_API_KEY"] = "env-test-key"

        try:
            veto = await Veto.init(VetoOptions(log_level="silent"))
            assert veto._cloud_client._api_key == "env-test-key"
        finally:
            if old_key is None:
                os.environ.pop("VETO_API_KEY", None)
            else:
                os.environ["VETO_API_KEY"] = old_key

    async def test_init_accepts_stream_log_level_from_env(self, monkeypatch: pytest.MonkeyPatch):
        """Should honor VETO_LOG_LEVEL=stream."""
        monkeypatch.setenv("VETO_LOG_LEVEL", "stream")

        veto = await Veto.init(VetoOptions(api_key="test-api-key"))

        assert veto._resolved_log_level == "stream"


class TestVetoWrap:
    """Tests for Veto.wrap() method."""

    async def test_wrap_preserves_tool_attributes(self, mock_cloud_client):
        """Should wrap tools and preserve their attributes."""

        class MockTool:
            name = "test_tool"
            description = "Test tool"

            async def handler(self, args):
                return "result"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])

        assert len(wrapped) == 1
        assert wrapped[0].name == "test_tool"

    async def test_wrap_executes_handler_when_allowed(self, mock_cloud_client):
        """Should execute handler when validation passes."""
        call_count = 0

        class MockTool:
            name = "allowed_tool"
            description = "Tool that should be allowed"

            async def handler(self, args):
                nonlocal call_count
                call_count += 1
                return "success"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        result = await wrapped[0].handler({})

        assert result == "success"
        assert call_count == 1

    async def test_wrap_blocks_when_denied(self, mock_cloud_client):
        """Should block execution when validation fails."""
        # Configure mock to deny
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="deny",
                reason="Blocked by test",
            )
        )

        class MockTool:
            name = "blocked_tool"
            description = "Tool that should be blocked"

            async def handler(self, args):
                return "should not reach here"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])

        from veto.core.interceptor import ToolCallDeniedError

        with pytest.raises(ToolCallDeniedError):
            await wrapped[0].handler({})

    async def test_wrap_extracts_tool_signature(self, mock_cloud_client):
        """Should extract and register tool signatures with cloud."""

        class MockTool:
            name = "signature_tool"
            description = "Tool with parameters"

            async def handler(self, query: str, limit: int = 10):
                return f"Results for {query} (limit {limit})"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        # Replace cloud client BEFORE wrapping so registration uses mock
        veto._cloud_client = mock_cloud_client

        # Need to await the registration which happens in wrap
        import asyncio

        veto.wrap([tool])
        # Give async task time to complete
        await asyncio.sleep(0.1)

        # Verify register_tools was called
        mock_cloud_client.register_tools.assert_called_once()


class TestVetoHistory:
    """Tests for Veto history tracking."""

    async def test_tracks_allowed_calls(self, mock_cloud_client):
        """Should track allowed tool calls."""

        class MockTool:
            name = "tracked_tool"
            description = "Tracked tool"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({})

        stats = veto.get_history_stats()
        assert stats.total_calls == 1
        assert stats.allowed_calls == 1
        assert stats.denied_calls == 0

    async def test_tracks_denied_calls(self, mock_cloud_client):
        """Should track denied tool calls."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="deny",
                reason="Blocked",
            )
        )

        class MockTool:
            name = "denied_tool"
            description = "Tool that gets denied"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])

        from veto.core.interceptor import ToolCallDeniedError

        try:
            await wrapped[0].handler({})
        except ToolCallDeniedError:
            pass

        stats = veto.get_history_stats()
        assert stats.total_calls == 1
        assert stats.denied_calls == 1

    async def test_clear_history(self, mock_cloud_client):
        """Should clear history."""

        class MockTool:
            name = "clear_test_tool"
            description = "Tool for clear test"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({})
        assert veto.get_history_stats().total_calls == 1

        veto.clear_history()
        assert veto.get_history_stats().total_calls == 0

    async def test_get_history_entries(self, mock_cloud_client):
        """Should return history entries."""

        class MockTool:
            name = "history_tool"
            description = "Tool for history test"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({"key": "value"})

        stats = veto.get_history_stats()
        assert stats.total_calls == 1
        assert "history_tool" in stats.calls_by_tool

    async def test_export_decisions(self, mock_cloud_client):
        """Should export decision history through Veto facade."""

        class MockTool:
            name = "export_tool"
            description = "Tool for export test"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({"amount": 123})

        exported_json = veto.export_decisions("json")
        assert "tool_name" in exported_json
        assert "export_tool" in exported_json

        exported_csv = veto.export_decisions("csv")
        assert (
            exported_csv.split("\n")[0]
            == "timestamp,tool_name,arguments,policy_version,rule_id,decision,reason"
        )


class TestVetoModes:
    """Tests for Veto operating modes."""

    async def test_strict_mode_is_default(self):
        """Strict mode should be default."""
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        assert veto._mode == "strict"

    async def test_log_mode_from_options(self):
        """Should respect log mode from options."""
        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                mode="log",
                log_level="silent",
            )
        )
        assert veto._mode == "log"

    async def test_log_mode_allows_but_logs(self, mock_cloud_client):
        """Log mode should allow denied calls but log them."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="deny",
                reason="Would be blocked",
            )
        )

        class MockTool:
            name = "log_mode_tool"
            description = "Tool for log mode test"

            async def handler(self, args):
                return "executed"

        tool = MockTool()
        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                mode="log",
                log_level="silent",
            )
        )
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        # In log mode, this should NOT raise an exception
        result = await wrapped[0].handler({})
        assert result == "executed"


class TestGuard:
    """Tests for Veto.guard() standalone checks."""

    async def test_guard_returns_allow(self, mock_cloud_client):
        """Should return allow decision without throwing."""
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        result = await veto.guard("allow_tool", {"safe": True})

        assert result.decision == "allow"
        assert result.reason == "Allowed by mock"
        assert veto.get_history_stats().total_calls == 1

    async def test_guard_returns_deny(self, mock_cloud_client):
        """Should return deny decision without throwing."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="deny",
                reason="Blocked by policy",
                metadata={"ruleId": "deny-rule", "severity": "high"},
            )
        )

        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        result = await veto.guard("deny_tool", {"dangerous": True})

        assert result.decision == "deny"
        assert result.reason == "Blocked by policy"
        assert result.rule_id == "deny-rule"
        assert result.severity == "high"

    async def test_guard_returns_require_approval_with_approval_id(
        self, mock_cloud_client
    ):
        """Should return require_approval and preserve approval_id."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Needs review",
                approval_id="appr-guard-001",
            )
        )
        mock_cloud_client.poll_approval = AsyncMock()

        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        result = await veto.guard("approval_tool", {"amount": 5000})

        assert result.decision == "require_approval"
        assert result.reason == "Needs review"
        assert result.approval_id == "appr-guard-001"
        mock_cloud_client.poll_approval.assert_not_called()

    async def test_guard_defaults_to_allow_when_no_validators(self, mock_cloud_client):
        """Should allow by default when no validators are configured."""
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client
        veto._validation_engine.clear_validators()

        result = await veto.guard("unconfigured_tool", {"x": 1})

        assert result.decision == "allow"
        mock_cloud_client.validate.assert_not_called()

    async def test_guard_returns_deny_in_log_mode(self, mock_cloud_client):
        """Guard should keep deny verdicts in log mode."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="deny",
                reason="Would be blocked",
            )
        )

        veto = await Veto.init(
            VetoOptions(api_key="test", mode="log", log_level="silent")
        )
        veto._cloud_client = mock_cloud_client

        result = await veto.guard("log_mode_tool", {"request": "dangerous"})

        assert result.decision == "deny"
        assert result.reason == "Would be blocked"

    async def test_guard_context_overrides_identity_fields(self, mock_cloud_client):
        """Per-call identity fields should override instance defaults."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="allow",
                reason="ok",
            )
        )

        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                log_level="silent",
                session_id="default-session",
                agent_id="default-agent",
                user_id="default-user",
                role="analyst",
            )
        )
        veto._cloud_client = mock_cloud_client

        await veto.guard("context_tool", {"x": 1})
        first_call = mock_cloud_client.validate.call_args_list[0]
        assert first_call.kwargs["context"]["session_id"] == "default-session"
        assert first_call.kwargs["context"]["agent_id"] == "default-agent"
        assert first_call.kwargs["context"]["user_id"] == "default-user"
        assert first_call.kwargs["context"]["role"] == "analyst"

        await veto.guard(
            "context_tool",
            {"x": 2},
            session_id="override-session",
            agent_id="override-agent",
            user_id="override-user",
            role="admin",
        )
        second_call = mock_cloud_client.validate.call_args_list[1]
        assert second_call.kwargs["context"]["session_id"] == "override-session"
        assert second_call.kwargs["context"]["agent_id"] == "override-agent"
        assert second_call.kwargs["context"]["user_id"] == "override-user"
        assert second_call.kwargs["context"]["role"] == "admin"

    async def test_custom_validator_receives_user_id_and_role(
        self, mock_cloud_client
    ):
        """ValidationContext should include user_id and role for custom validators."""
        seen_contexts: list[ValidationContext] = []

        def capture_context(context: ValidationContext) -> ValidationResult:
            seen_contexts.append(context)
            return ValidationResult(decision="allow")

        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                log_level="silent",
                user_id="default-user",
                role="analyst",
                validators=[capture_context],
            )
        )
        veto._cloud_client = mock_cloud_client

        await veto.guard("validator_context_tool", {"x": 1})
        await veto.guard(
            "validator_context_tool",
            {"x": 2},
            user_id="override-user",
            role="admin",
        )

        assert seen_contexts[0].user_id == "default-user"
        assert seen_contexts[0].role == "analyst"
        assert seen_contexts[1].user_id == "override-user"
        assert seen_contexts[1].role == "admin"


class TestCloudValidation:
    """Tests for cloud validation integration."""

    async def test_passes_arguments_to_cloud(self, mock_cloud_client):
        """Should pass tool arguments to cloud for validation."""

        class MockTool:
            name = "validate_args_tool"
            description = "Tool to test argument passing"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({"amount": 500, "currency": "USD"})

        # Verify validate was called with the arguments
        mock_cloud_client.validate.assert_called_once()
        call_args = mock_cloud_client.validate.call_args
        assert call_args.kwargs["tool_name"] == "validate_args_tool"
        assert call_args.kwargs["arguments"] == {"amount": 500, "currency": "USD"}


class TestApprovalFlow:
    """Tests for require_approval flow."""

    async def test_approval_allowed(self, mock_cloud_client):
        """Should allow tool call when approval is granted."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Needs review",
                approval_id="appr-001",
            )
        )
        mock_cloud_client.poll_approval = AsyncMock(
            return_value=ApprovalData(
                id="appr-001",
                status="approved",
                tool_name="sensitive_tool",
                resolved_by="admin@corp.com",
            )
        )

        class MockTool:
            name = "sensitive_tool"
            description = "Sensitive tool"

            async def handler(self, args):
                return "executed"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        result = await wrapped[0].handler({"data": "sensitive"})

        assert result == "executed"
        mock_cloud_client.poll_approval.assert_called_once()

    async def test_approval_denied(self, mock_cloud_client):
        """Should deny tool call when approval is denied."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Needs review",
                approval_id="appr-002",
            )
        )
        mock_cloud_client.poll_approval = AsyncMock(
            return_value=ApprovalData(
                id="appr-002",
                status="denied",
                tool_name="dangerous_tool",
                resolved_by="admin",
            )
        )

        class MockTool:
            name = "dangerous_tool"
            description = "Dangerous tool"

            async def handler(self, args):
                return "should not reach"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])

        from veto.core.interceptor import ToolCallDeniedError

        with pytest.raises(ToolCallDeniedError):
            await wrapped[0].handler({})

    async def test_approval_timeout(self, mock_cloud_client):
        """Should deny when approval times out."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Review needed",
                approval_id="appr-003",
            )
        )
        mock_cloud_client.poll_approval = AsyncMock(
            side_effect=ApprovalTimeoutError("appr-003", 0.05)
        )

        class MockTool:
            name = "timeout_tool"
            description = "Tool that times out"

            async def handler(self, args):
                return "should not reach"

        tool = MockTool()
        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                log_level="silent",
                approval_timeout=0.05,
            )
        )
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])

        from veto.core.interceptor import ToolCallDeniedError

        with pytest.raises(ToolCallDeniedError):
            await wrapped[0].handler({})

    async def test_on_approval_required_hook(self, mock_cloud_client):
        """Should fire on_approval_required callback with ValidationContext."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Needs human",
                approval_id="appr-004",
            )
        )
        mock_cloud_client.poll_approval = AsyncMock(
            return_value=ApprovalData(
                id="appr-004",
                status="approved",
                tool_name="hook_tool",
                resolved_by="user",
            )
        )

        hook_calls: list[tuple] = []

        def on_approval(context, approval_id):
            hook_calls.append((context, approval_id))

        class MockTool:
            name = "hook_tool"
            description = "Tool for hook test"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                log_level="silent",
                on_approval_required=on_approval,
            )
        )
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({})

        assert len(hook_calls) == 1
        ctx = hook_calls[0][0]
        assert isinstance(ctx, ValidationContext)
        assert ctx.tool_name == "hook_tool"
        assert hook_calls[0][1] == "appr-004"

    async def test_configurable_poll_options(self, mock_cloud_client):
        """Should pass configured poll options to cloud client."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Review",
                approval_id="appr-005",
            )
        )
        mock_cloud_client.poll_approval = AsyncMock(
            return_value=ApprovalData(
                id="appr-005",
                status="approved",
                tool_name="poll_tool",
                resolved_by="reviewer",
            )
        )

        class MockTool:
            name = "poll_tool"
            description = "Tool for poll options test"

            async def handler(self, args):
                return "ok"

        tool = MockTool()
        veto = await Veto.init(
            VetoOptions(
                api_key="test",
                log_level="silent",
                approval_poll_interval=0.5,
                approval_timeout=10.0,
            )
        )
        veto._cloud_client = mock_cloud_client

        wrapped = veto.wrap([tool])
        await wrapped[0].handler({})

        # Verify poll_approval was called with the configured options
        mock_cloud_client.poll_approval.assert_called_once()
        poll_opts = mock_cloud_client.poll_approval.call_args.kwargs.get("options")
        assert poll_opts is not None, "poll_approval should receive options kwarg"
        assert poll_opts.poll_interval == 0.5
        assert poll_opts.timeout == 10.0


class TestApprovalPreferences:
    """Tests for approve all / deny all preference cache."""

    async def test_approve_all_skips_polling(self, mock_cloud_client):
        """Should auto-approve without polling when approve_all is set."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Needs review",
                approval_id="appr-pref-001",
            )
        )

        class MockTool:
            name = "pref_tool"
            description = "Tool for pref test"

            async def handler(self, args):
                return "auto-approved"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        # Set approve_all preference
        veto.set_approval_preference("pref_tool", "approve_all")
        assert veto.get_approval_preference("pref_tool") == "approve_all"

        wrapped = veto.wrap([tool])
        result = await wrapped[0].handler({})

        assert result == "auto-approved"
        # poll_approval should NOT have been called
        mock_cloud_client.poll_approval.assert_not_called()

    async def test_deny_all_skips_polling(self, mock_cloud_client):
        """Should auto-deny without polling when deny_all is set."""
        mock_cloud_client.validate = AsyncMock(
            return_value=ValidationResponse(
                decision="require_approval",
                reason="Needs review",
                approval_id="appr-pref-002",
            )
        )

        class MockTool:
            name = "deny_pref_tool"
            description = "Tool for deny pref test"

            async def handler(self, args):
                return "should not reach"

        tool = MockTool()
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))
        veto._cloud_client = mock_cloud_client

        veto.set_approval_preference("deny_pref_tool", "deny_all")

        wrapped = veto.wrap([tool])

        from veto.core.interceptor import ToolCallDeniedError

        with pytest.raises(ToolCallDeniedError):
            await wrapped[0].handler({})

        mock_cloud_client.poll_approval.assert_not_called()

    async def test_clear_preferences(self, mock_cloud_client):
        """Should clear preferences so polling resumes."""
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))

        veto.set_approval_preference("tool_a", "approve_all")
        veto.set_approval_preference("tool_b", "deny_all")

        assert veto.get_approval_preference("tool_a") == "approve_all"
        assert veto.get_approval_preference("tool_b") == "deny_all"

        # Clear specific tool
        veto.clear_approval_preferences("tool_a")
        assert veto.get_approval_preference("tool_a") is None
        assert veto.get_approval_preference("tool_b") == "deny_all"

        # Clear all
        veto.clear_approval_preferences()
        assert veto.get_approval_preference("tool_b") is None

    async def test_invalid_preference_raises(self, mock_cloud_client):
        """Should raise ValueError for invalid preference."""
        veto = await Veto.init(VetoOptions(api_key="test", log_level="silent"))

        with pytest.raises(ValueError):
            veto.set_approval_preference("tool", "invalid")
