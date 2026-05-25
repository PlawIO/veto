from pathlib import Path

from veto.cli import main


def test_cli_init_creates_documented_files(tmp_path: Path) -> None:
    target = tmp_path / "veto"

    assert main(["init", "--directory", str(target)]) == 0

    assert (target / "veto.config.yaml").exists()
    assert (target / "rules" / "defaults.yaml").exists()


def test_cli_validate_policy_reports_valid_yaml(tmp_path: Path) -> None:
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

    assert main(["validate-policy", str(policy)]) == 0

