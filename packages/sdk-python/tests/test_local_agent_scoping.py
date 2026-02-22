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


async def test_local_agents_include_scope_matches_current_agent(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "agents-include.yaml").write_text(
        """
version: "1.0"
rules:
  - id: include-agents
    name: Include agents
    action: block
    tools: [deploy]
    agents:
      - agent-a
      - agent-b
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(
        VetoOptions(
            config_dir=str(veto_dir),
            log_level="silent",
            agent_id="agent-a",
        )
    )

    matching = await veto.guard("deploy", {})
    non_matching = await veto.guard("deploy", {}, agent_id="agent-c")

    assert matching.decision == "deny"
    assert matching.rule_id == "include-agents"
    assert non_matching.decision == "allow"


async def test_local_agents_exclusion_scope_skips_excluded_agents(
    tmp_path: Path,
) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "agents-exclude.yaml").write_text(
        """
version: "1.0"
rules:
  - id: exclude-agents
    name: Exclude agents
    action: block
    tools: [deploy]
    agents:
      not:
        - internal-agent
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(
        VetoOptions(
            config_dir=str(veto_dir),
            log_level="silent",
            agent_id="internal-agent",
        )
    )

    excluded = await veto.guard("deploy", {})
    included = await veto.guard("deploy", {}, agent_id="external-agent")

    assert excluded.decision == "allow"
    assert included.decision == "deny"
    assert included.rule_id == "exclude-agents"


async def test_local_rules_without_agents_scope_apply_to_everyone(
    tmp_path: Path,
) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "agents-none.yaml").write_text(
        """
version: "1.0"
rules:
  - id: no-agents
    name: No agent scope
    action: block
    tools: [deploy]
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(
        VetoOptions(
            config_dir=str(veto_dir),
            log_level="silent",
            agent_id="agent-a",
        )
    )

    first = await veto.guard("deploy", {})
    second = await veto.guard("deploy", {}, agent_id="agent-b")

    assert first.decision == "deny"
    assert first.rule_id == "no-agents"
    assert second.decision == "deny"
    assert second.rule_id == "no-agents"


async def test_local_agents_scope_combines_with_conditions(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    rules_dir = _write_local_config(veto_dir)
    (rules_dir / "agents-conditions.yaml").write_text(
        """
version: "1.0"
rules:
  - id: scoped-amount
    name: Scoped amount rule
    action: block
    tools: [transfer_funds]
    agents:
      - ops-agent
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
""".strip()
        + "\n",
        encoding="utf-8",
    )

    veto = await Veto.init(
        VetoOptions(
            config_dir=str(veto_dir),
            log_level="silent",
            agent_id="ops-agent",
        )
    )

    low_value = await veto.guard("transfer_funds", {"amount": 100})
    high_value_scoped = await veto.guard("transfer_funds", {"amount": 5000})
    high_value_other_agent = await veto.guard(
        "transfer_funds",
        {"amount": 5000},
        agent_id="support-agent",
    )

    assert low_value.decision == "allow"
    assert high_value_scoped.decision == "deny"
    assert high_value_scoped.rule_id == "scoped-amount"
    assert high_value_other_agent.decision == "allow"
