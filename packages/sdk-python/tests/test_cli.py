import json
from pathlib import Path

from veto.cli import main


def _json_out(capsys) -> dict:
    return json.loads(capsys.readouterr().out)


def test_version_json_reports_python_runtime(capsys) -> None:
    assert main(["version", "--json"]) == 0
    payload = _json_out(capsys)
    assert payload["ok"] is True
    assert payload["data"]["runtime"] == "python"
    assert "version" in payload["data"]


def test_cli_init_creates_documented_files_and_receipt_smoke(tmp_path: Path, capsys) -> None:
    assert main(["init", "--directory", str(tmp_path), "--json"]) == 0
    payload = _json_out(capsys)

    assert payload["ok"] is True
    assert (tmp_path / "veto" / "veto.config.yaml").exists()
    assert (tmp_path / "veto" / "rules" / "defaults.yaml").exists()
    assert (tmp_path / "veto" / "mcp.config.yaml").exists()
    assert payload["data"]["receipt"] is True
    assert (tmp_path / ".veto" / "receipts.ndjson").exists()


def test_cli_validate_policy_reports_valid_yaml(tmp_path: Path, capsys) -> None:
    policy = tmp_path / "policy.yaml"
    policy.write_text(
        """
version: "1.0"
rules:
  - id: block-rm
    name: Block rm
    action: block
    tools: [bash]
    conditions:
      - field: arguments.command
        operator: contains
        value: rm -rf
""".strip()
        + "\n",
        encoding="utf-8",
    )

    assert main(["validate-policy", str(policy), "--json"]) == 0
    assert _json_out(capsys)["ok"] is True


def test_validate_json_returns_receipt_and_writes_chain(tmp_path: Path, capsys) -> None:
    assert main(["init", "--directory", str(tmp_path), "--json"]) == 0
    capsys.readouterr()
    receipt_path = tmp_path / ".veto" / "receipts.ndjson"

    assert main([
        "validate",
        "bash",
        "--arguments",
        '{"command":"rm -rf /tmp/demo"}',
        "--config-dir",
        str(tmp_path / "veto"),
        "--receipt-store",
        str(receipt_path),
        "--session-id",
        "sess_cli",
        "--agent-id",
        "agent_cli",
        "--json",
    ]) == 0
    payload = _json_out(capsys)

    assert payload["ok"] is True
    assert payload["data"]["decision"] == "deny"
    assert payload["data"]["receipt"]["receipt_hash"].startswith("sha256:")

    assert main(["receipts", "verify", str(receipt_path), "--json"]) == 0
    verified = _json_out(capsys)
    assert verified["data"]["count"] == 2


def test_receipts_show_json_returns_file_receipt_and_summary(tmp_path: Path, capsys) -> None:
    assert main(["init", "--directory", str(tmp_path), "--json"]) == 0
    capsys.readouterr()
    receipt_path = tmp_path / ".veto" / "receipts.ndjson"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8").splitlines()[0])

    assert main([
        "receipts",
        "show",
        receipt["receipt_id"],
        "--file",
        str(receipt_path),
        "--json",
    ]) == 0
    payload = _json_out(capsys)
    assert payload["data"]["receipt"]["receipt_id"] == receipt["receipt_id"]
    assert payload["data"]["summary"]["previous_receipt_hash"].startswith("sha256:")


def test_receipts_verify_invalid_json_returns_stable_error(tmp_path: Path, capsys) -> None:
    receipt_path = tmp_path / "receipts.ndjson"
    receipt_path.write_text("{bad-json\n", encoding="utf-8")

    assert main(["receipts", "verify", str(receipt_path), "--json"]) == 1
    payload = _json_out(capsys)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "receipt_verify_failed"


def test_mcp_import_and_restore_json(tmp_path: Path, capsys) -> None:
    client_path = tmp_path / "mcp.json"
    gateway_path = tmp_path / "veto" / "mcp.config.yaml"
    client_path.write_text(
        json.dumps({"mcpServers": {"files": {"command": "node", "args": ["server.js"]}}}),
        encoding="utf-8",
    )

    assert main([
        "mcp",
        "import",
        "--output",
        str(client_path),
        "--config",
        str(gateway_path),
        "--json",
    ]) == 0
    imported = _json_out(capsys)
    assert imported["ok"] is True
    backup_path = Path(imported["data"]["backupPath"])
    assert backup_path.exists()
    assert json.loads(client_path.read_text(encoding="utf-8"))["mcpServers"]["veto"]["command"] == "veto"

    assert main(["mcp", "restore", "--backup", str(backup_path), "--json"]) == 0
    restored = _json_out(capsys)
    assert restored["ok"] is True
    assert "veto" not in json.loads(client_path.read_text(encoding="utf-8"))["mcpServers"]


def test_import_mcp_alias_matches_mcp_import(tmp_path: Path, capsys) -> None:
    client_path = tmp_path / "mcp.json"

    assert main(["import", "mcp", "--output", str(client_path), "--dry-run", "--json"]) == 0
    payload = _json_out(capsys)
    assert payload["data"]["dryRun"] is True
    assert "veto" in payload["data"]["servers"]
