"""
Tests for event webhooks and payload formatting.
"""

import asyncio
import json
from pathlib import Path

from veto import Veto, VetoOptions
from veto.core.events import (
    WebhookEvent,
    format_cef_payload,
    format_generic_payload,
    format_pagerduty_payload,
    format_slack_payload,
)
from veto.types.config import ValidationContext, ValidationResult


def _write_config(veto_dir: Path, extra: str) -> None:
    (veto_dir / "veto.config.yaml").write_text(
        (
            'version: "1.0"\n'
            'mode: "strict"\n'
            "validation:\n"
            '  mode: "local"\n'
            "logging:\n"
            '  level: "silent"\n'
            "rules:\n"
            '  directory: "./rules"\n'
            f"{extra}\n"
        ),
        encoding="utf-8",
    )


def _write_rules(veto_dir: Path, content: str) -> None:
    rules_dir = veto_dir / "rules"
    rules_dir.mkdir(parents=True, exist_ok=True)
    (rules_dir / "rules.yaml").write_text(content, encoding="utf-8")


def _sample_event() -> WebhookEvent:
    return WebhookEvent(
        event_type="deny",
        tool_name="send_email",
        arguments={"to": "team@example.com", "subject": "Status"},
        decision="deny",
        reason="Sensitive recipient blocked",
        rule_id="email-deny-001",
        severity="high",
        timestamp="2026-02-22T10:00:00.000Z",
    )


class TestEventWebhookAdapters:
    def test_slack_payload_shape(self) -> None:
        payload = format_slack_payload(_sample_event())
        assert "blocks" in payload
        assert isinstance(payload["blocks"], list)
        assert payload["text"].startswith("Veto deny")

    def test_pagerduty_payload_shape(self) -> None:
        payload = format_pagerduty_payload(_sample_event())
        assert payload["event_action"] == "trigger"
        assert payload["payload"]["severity"] == "error"
        custom_details = payload["payload"]["custom_details"]
        assert custom_details["event_type"] == "deny"
        assert custom_details["tool_name"] == "send_email"

    def test_generic_payload_shape(self) -> None:
        payload = format_generic_payload(_sample_event())
        assert payload == {
            "event_type": "deny",
            "tool_name": "send_email",
            "arguments": {"to": "team@example.com", "subject": "Status"},
            "decision": "deny",
            "reason": "Sensitive recipient blocked",
            "rule_id": "email-deny-001",
            "severity": "high",
            "timestamp": "2026-02-22T10:00:00.000Z",
        }

    def test_cef_payload_shape(self) -> None:
        payload = format_cef_payload(_sample_event())
        assert payload.startswith("CEF:0|Veto|SDK|1.0|email-deny-001|")
        assert "eventType=deny" in payload
        assert "toolName=send_email" in payload


class TestEventWebhooks:
    async def test_webhook_fires_on_deny(self, tmp_path: Path) -> None:
        veto_dir = tmp_path / "veto"
        veto_dir.mkdir(parents=True, exist_ok=True)
        _write_config(
            veto_dir,
            (
                "events:\n"
                "  webhook:\n"
                '    url: "https://hooks.example.com/veto"\n'
                '    on: ["deny"]\n'
                '    min_severity: "info"\n'
                '    format: "generic"\n'
            ),
        )
        _write_rules(
            veto_dir,
            (
                'version: "1.0"\n'
                "name: deny-rules\n"
                "rules:\n"
                "  - id: deny-sensitive\n"
                "    name: Deny sensitive path\n"
                "    enabled: true\n"
                "    severity: high\n"
                "    action: block\n"
                "    tools: [read_file]\n"
                "    conditions:\n"
                "      - field: arguments.path\n"
                "        operator: starts_with\n"
                "        value: /etc\n"
            ),
        )

        veto = await Veto.init(
            VetoOptions(config_dir=str(veto_dir), log_level="silent")
        )

        sent: list[tuple[str, bytes, str]] = []

        async def fake_send_async(url: str, body: bytes, content_type: str) -> int:
            sent.append((url, body, content_type))
            return 202

        setattr(veto._event_webhook_emitter, "_send_async", fake_send_async)

        result = await veto.guard("read_file", {"path": "/etc/passwd"})
        assert result.decision == "deny"

        await asyncio.sleep(0)
        assert len(sent) == 1
        assert sent[0][0] == "https://hooks.example.com/veto"
        assert sent[0][2] == "application/json"
        payload = json.loads(sent[0][1].decode("utf-8"))
        assert payload["event_type"] == "deny"
        assert payload["tool_name"] == "read_file"
        assert payload["severity"] == "high"

    async def test_allow_does_not_fire_when_not_in_on_list(self, tmp_path: Path) -> None:
        veto_dir = tmp_path / "veto"
        veto_dir.mkdir(parents=True, exist_ok=True)
        _write_config(
            veto_dir,
            (
                "events:\n"
                "  webhook:\n"
                '    url: "https://hooks.example.com/veto"\n'
                '    on: ["deny"]\n'
                '    min_severity: "info"\n'
                '    format: "generic"\n'
            ),
        )
        _write_rules(
            veto_dir,
            (
                'version: "1.0"\n'
                "name: allow-rules\n"
                "rules:\n"
                "  - id: allow-safe\n"
                "    name: Allow safe path\n"
                "    enabled: true\n"
                "    severity: low\n"
                "    action: allow\n"
                "    tools: [read_file]\n"
                "    conditions:\n"
                "      - field: arguments.path\n"
                "        operator: starts_with\n"
                "        value: /tmp\n"
            ),
        )

        veto = await Veto.init(
            VetoOptions(config_dir=str(veto_dir), log_level="silent")
        )

        sent: list[tuple[str, bytes, str]] = []

        async def fake_send_async(url: str, body: bytes, content_type: str) -> int:
            sent.append((url, body, content_type))
            return 202

        setattr(veto._event_webhook_emitter, "_send_async", fake_send_async)

        result = await veto.guard("read_file", {"path": "/tmp/report.txt"})
        assert result.decision == "allow"

        await asyncio.sleep(0)
        assert len(sent) == 0

    async def test_min_severity_filtering(self, tmp_path: Path) -> None:
        veto_dir = tmp_path / "veto"
        veto_dir.mkdir(parents=True, exist_ok=True)
        _write_config(
            veto_dir,
            (
                "events:\n"
                "  webhook:\n"
                '    url: "https://hooks.example.com/veto"\n'
                '    on: ["deny"]\n'
                '    min_severity: "high"\n'
                '    format: "generic"\n'
            ),
        )
        _write_rules(
            veto_dir,
            (
                'version: "1.0"\n'
                "name: severity-rules\n"
                "rules:\n"
                "  - id: low-deny\n"
                "    name: Low deny\n"
                "    enabled: true\n"
                "    severity: low\n"
                "    action: block\n"
                "    tools: [low_tool]\n"
                "    conditions:\n"
                "      - field: arguments.trigger\n"
                "        operator: equals\n"
                "        value: true\n"
                "  - id: high-deny\n"
                "    name: High deny\n"
                "    enabled: true\n"
                "    severity: high\n"
                "    action: block\n"
                "    tools: [high_tool]\n"
                "    conditions:\n"
                "      - field: arguments.trigger\n"
                "        operator: equals\n"
                "        value: true\n"
            ),
        )

        veto = await Veto.init(
            VetoOptions(config_dir=str(veto_dir), log_level="silent")
        )

        sent: list[tuple[str, bytes, str]] = []

        async def fake_send_async(url: str, body: bytes, content_type: str) -> int:
            sent.append((url, body, content_type))
            return 202

        setattr(veto._event_webhook_emitter, "_send_async", fake_send_async)

        low_result = await veto.guard("low_tool", {"trigger": True})
        high_result = await veto.guard("high_tool", {"trigger": True})
        assert low_result.decision == "deny"
        assert high_result.decision == "deny"

        await asyncio.sleep(0)
        assert len(sent) == 1
        payload = json.loads(sent[0][1].decode("utf-8"))
        assert payload["rule_id"] == "high-deny"
        assert payload["severity"] == "high"

    async def test_webhook_failure_does_not_block_validation(self, tmp_path: Path) -> None:
        veto_dir = tmp_path / "veto"
        veto_dir.mkdir(parents=True, exist_ok=True)
        _write_config(
            veto_dir,
            (
                "events:\n"
                "  webhook:\n"
                '    url: "https://hooks.example.com/veto"\n'
                '    on: ["deny"]\n'
                '    min_severity: "info"\n'
                '    format: "generic"\n'
            ),
        )
        _write_rules(
            veto_dir,
            (
                'version: "1.0"\n'
                "name: deny-rules\n"
                "rules:\n"
                "  - id: deny-sensitive\n"
                "    name: Deny sensitive path\n"
                "    enabled: true\n"
                "    severity: high\n"
                "    action: block\n"
                "    tools: [read_file]\n"
                "    conditions:\n"
                "      - field: arguments.path\n"
                "        operator: starts_with\n"
                "        value: /etc\n"
            ),
        )

        veto = await Veto.init(
            VetoOptions(config_dir=str(veto_dir), log_level="silent")
        )

        async def failing_send_async(
            url: str, body: bytes, content_type: str
        ) -> int:
            raise RuntimeError("webhook unavailable")

        setattr(veto._event_webhook_emitter, "_send_async", failing_send_async)

        result = await veto.guard("read_file", {"path": "/etc/passwd"})
        assert result.decision == "deny"
        await asyncio.sleep(0)

    async def test_budget_exceeded_event_fires(self, tmp_path: Path) -> None:
        veto_dir = tmp_path / "veto"
        veto_dir.mkdir(parents=True, exist_ok=True)
        _write_config(
            veto_dir,
            (
                "events:\n"
                "  webhook:\n"
                '    url: "https://hooks.example.com/veto"\n'
                '    on: ["budget_exceeded"]\n'
                '    min_severity: "info"\n'
                '    format: "generic"\n'
            ),
        )
        _write_rules(
            veto_dir,
            (
                'version: "1.0"\n'
                "name: empty-rules\n"
                "rules: []\n"
            ),
        )

        async def budget_validator(context: ValidationContext) -> ValidationResult:
            if context.tool_name == "charge_card":
                return ValidationResult(
                    decision="deny",
                    reason="Budget exceeded",
                    metadata={
                        "budget_exceeded": True,
                        "severity": "high",
                        "rule_id": "budget-limit",
                    },
                )
            return ValidationResult(decision="allow")

        veto = await Veto.init(
            VetoOptions(
                config_dir=str(veto_dir),
                log_level="silent",
                validators=[budget_validator],
            )
        )

        sent: list[tuple[str, bytes, str]] = []

        async def fake_send_async(url: str, body: bytes, content_type: str) -> int:
            sent.append((url, body, content_type))
            return 202

        setattr(veto._event_webhook_emitter, "_send_async", fake_send_async)

        result = await veto.guard("charge_card", {"amount": 42})
        assert result.decision == "deny"

        await asyncio.sleep(0)
        assert len(sent) == 1
        payload = json.loads(sent[0][1].decode("utf-8"))
        assert payload["event_type"] == "budget_exceeded"
        assert payload["decision"] == "deny"
        assert payload["severity"] == "high"
