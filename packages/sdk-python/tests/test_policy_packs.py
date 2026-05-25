from pathlib import Path

from veto import Veto, VetoOptions


def _write_local_config(veto_dir: Path) -> Path:
    rules_dir = veto_dir / "rules"
    rules_dir.mkdir(parents=True, exist_ok=True)

    (veto_dir / "veto.config.yaml").write_text(
        """
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
""".strip()
        + "\n",
        encoding="utf-8",
    )
    return rules_dir


async def test_extends_pack_inherits_rules(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "extends-pack.yaml").write_text(
        """
version: "1.0"
extends: "@veto/coding-agent"
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
    result = await veto.guard("run_shell", {"command": "rm -rf /tmp"})

    assert result.decision == "deny"
    assert result.rule_id == "coding-agent-block-dangerous-shell-commands"


async def test_extends_pack_allows_rule_override_by_id(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "override-pack.yaml").write_text(
        """
version: "1.0"
extends: "@veto/coding-agent"
rules:
  - id: coding-agent-block-dangerous-shell-commands
    name: Override shell rule
    action: block
    tools: [run_shell]
    conditions:
      - field: arguments.command
        operator: contains
        value: shutdown
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
    result = await veto.guard("run_shell", {"command": "rm -rf /tmp"})

    assert result.decision == "allow"


async def test_extends_pack_appends_new_rules(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "append-pack.yaml").write_text(
        """
version: "1.0"
extends: "@veto/coding-agent"
rules:
  - id: custom-block-prod-path
    name: Custom block for prod paths
    action: block
    tools: [write_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /prod
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
    inherited = await veto.guard("run_shell", {"command": "rm -rf /tmp"})
    custom = await veto.guard("write_file", {"path": "/prod/app.env"})

    assert inherited.decision == "deny"
    assert inherited.rule_id == "coding-agent-block-dangerous-shell-commands"
    assert custom.decision == "deny"
    assert custom.rule_id == "custom-block-prod-path"


async def test_extends_nonexistent_pack_is_handled_gracefully(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "bad-pack.yaml").write_text(
        """
version: "1.0"
extends: "@veto/does-not-exist"
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
    result = await veto.guard("run_shell", {"command": "rm -rf /tmp"})

    assert result.decision == "allow"


async def test_extends_crypto_trading_pack_matches_typescript_bundle(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "crypto.yaml").write_text(
        """
version: "1.0"
extends: "@veto/crypto-trading"
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
    result = await veto.guard("place_order", {"side": "buy", "quote_quantity": 2500})

    assert result.decision == "deny"
    assert result.rule_id == "crypto-max-position"


async def test_extends_compliance_pack_is_available_in_python(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "soc2.yaml").write_text(
        """
version: "1.0"
extends: "@veto/soc2-lite"
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir), log_level="silent"))
    result = await veto.guard("deploy", {"environment": "production"})

    assert result.decision == "require_approval"
    assert result.rule_id == "soc2-require-approval-production-release"
