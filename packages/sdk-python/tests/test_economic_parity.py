from __future__ import annotations

import math
from pathlib import Path

import pytest

from veto import (
    EconomicContext,
    EconomicEvaluator,
    LocalBudgetEngine,
    Veto,
    VetoOptions,
    create_ap2_connector,
    create_mpp_connector,
    create_x402_connector,
)
from veto.economic import parse_economic_budget_configs
from veto.utils.logger import create_logger


ECONOMIC_50_USD = {
    "budgets": [
        {"scope": "session", "limit": 50, "currency": "USD", "window": "session"}
    ],
    "cost_extraction": {"default": "arguments.cost"},
}


def _logger():
    return create_logger("silent")


def _engine(policy: dict) -> LocalBudgetEngine:
    return LocalBudgetEngine(
        budgets=parse_economic_budget_configs(policy["budgets"]),
        logger=_logger(),
    )


def test_local_budget_engine_matches_ts_semantics() -> None:
    policy = {
        "budgets": [
            {
                "scope": "session",
                "limit": 50,
                "currency": "USD",
                "approval_threshold": 20,
                "window": "session",
            }
        ]
    }
    engine = _engine(policy)

    assert engine.check(10, "USD", "session").decision == "allow"
    assert engine.check(25, "USD", "session").decision == "require_approval"
    assert engine.check(60, "USD", "session").denial.reason == "budget_exceeded"  # type: ignore[union-attr]
    assert engine.check(10, "EUR", "session").denial.reason == "currency_mismatch"  # type: ignore[union-attr]
    assert engine.check(math.nan, "USD", "session").decision == "allow"

    assert engine.reserve(20, "USD", "session").decision == "allow"
    assert engine.reserve(20, "USD", "session").decision == "allow"
    assert engine.reserve(15, "USD", "session").denial.reason == "budget_exceeded"  # type: ignore[union-attr]
    assert engine.get_status("session").spent == 40  # type: ignore[union-attr]
    engine.refund(15, "session")
    assert engine.get_status("session").spent == 25  # type: ignore[union-attr]
    engine.reset("session")
    assert engine.get_status("session").spent == 0  # type: ignore[union-attr]


def test_economic_evaluator_resolves_cost_payer_and_templates() -> None:
    policy = {
        "budgets": [
            {
                "scope": "session",
                "limit": 100,
                "currency": "USD",
                "approval_threshold": 50,
                "window": "session",
            }
        ],
        "cost_extraction": {
            "default": "arguments.cost",
            "overrides": {"search_api": "arguments.price_usd"},
        },
        "payer": {"required": True, "approved": ["wallet_0x123"]},
        "denial_reasons": {
            "budget_exceeded": "Would exceed {scope} budget ({spent}/{limit} {currency})"
        },
    }
    evaluator = EconomicEvaluator(
        policy=policy,
        budget_engine=_engine(policy),
        logger=_logger(),
    )

    assert evaluator.resolve_cost("pay_tool", {"cost": 25}) == 25
    assert evaluator.resolve_cost("search_api", {"price_usd": 0.05}) == 0.05
    assert evaluator.resolve_cost("pay_tool", {"cost": "expensive"}) is None

    assert evaluator.evaluate({"cost": 10, "currency": "USD", "protocol": "x402"}).denial.reason == "payer_missing"  # type: ignore[union-attr]
    assert evaluator.evaluate(
        EconomicContext(cost=10, currency="USD", protocol="x402", payer="wallet_0x123")
    ).decision == "allow"
    assert evaluator.evaluate(
        EconomicContext(cost=60, currency="USD", protocol="x402", payer="wallet_0x123")
    ).decision == "require_approval"
    denied = evaluator.evaluate(
        EconomicContext(cost=150, currency="USD", protocol="x402", payer="wallet_0x123")
    )
    assert denied.denial is not None
    assert denied.denial.reason == "budget_exceeded"
    assert denied.denial.message == "Would exceed session budget (0/100 USD)"


def test_protocol_connectors_extract_ts_shapes() -> None:
    x402 = create_x402_connector()
    ctx = x402.extract(
        {
            "status": 402,
            "headers": {
                "x-payment": "price=0.01;token=USDC;chain=base;recipient=0xabc123"
            },
        }
    )
    assert ctx is not None
    assert ctx.cost == 0.01
    assert ctx.currency == "USD"
    assert ctx.protocol == "x402"
    assert ctx.protocol_metadata["token"] == "USDC"  # type: ignore[index]
    assert x402.extract({"status": 402, "headers": {"x-payment": "price=1;token=ETH;chain=base;recipient=0xabc"}}) is None

    mpp = create_mpp_connector()
    mpp_ctx = mpp.extract(
        {
            "mpp_session": {
                "session_token": "spt_123",
                "cost": 2.5,
                "currency": "usd",
                "payer": "cus_123",
            }
        }
    )
    assert mpp_ctx is not None
    assert mpp_ctx.cost == 2.5
    assert mpp_ctx.currency == "USD"
    assert mpp_ctx.payer == "cus_123"

    ap2 = create_ap2_connector()
    ap2_ctx = ap2.extract(
        {
            "ap2_mandate": {
                "mandate_id": "mandate_123",
                "cost": 5,
                "currency": "usd",
                "signer": "user@example.com",
                "spending_cap": 10,
                "spent": 2,
            }
        }
    )
    assert ap2_ctx is not None
    assert ap2_ctx.protocol == "ap2"
    assert ap2_ctx.protocol_metadata["mandate_id"] == "mandate_123"  # type: ignore[index]


def _write_config(veto_dir: Path, economic: str, *, mode: str = "strict") -> None:
    rules_dir = veto_dir / "rules"
    rules_dir.mkdir(parents=True)
    (veto_dir / "veto.config.yaml").write_text(
        f"""version: "1.0"
mode: "{mode}"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
{economic}
""",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_guard_enforces_explicit_and_implicit_economic_context(tmp_path: Path) -> None:
    veto_dir = tmp_path / "veto"
    _write_config(
        veto_dir,
        """economic:
  budgets:
    - scope: session
      limit: 50
      currency: USD
      window: session
  cost_extraction:
    default: arguments.cost
""",
    )
    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir)))

    first = await veto.guard(
        "pay_tool",
        {"amount": 10},
        economic={"cost": 10, "currency": "USD", "protocol": "custom"},
    )
    assert first.decision == "allow"
    assert veto.get_economic_budget_status().spent == 10  # type: ignore[union-attr]

    denied = await veto.guard("pay_tool", {"cost": 45})
    assert denied.decision == "deny"
    assert denied.economic_denial is not None
    assert denied.economic_denial.reason == "budget_exceeded"

    veto.reset_economic_budget()
    assert veto.getEconomicBudgetStatus().spent == 0  # type: ignore[union-attr]
    allowed = await veto.guard("pay_tool", {"cost": 45})
    assert allowed.decision == "allow"


@pytest.mark.asyncio
async def test_require_payment_rule_fails_closed_and_allows_when_budget_passes(
    tmp_path: Path,
) -> None:
    veto_dir = tmp_path / "veto"
    _write_config(
        veto_dir,
        """economic:
  budgets:
    - scope: session
      limit: 10
      currency: USD
      window: session
""",
    )
    (veto_dir / "rules" / "rules.yaml").write_text(
        """version: "1.0"
name: test
rules:
  - id: gate-tool
    name: Gate Tool
    enabled: true
    severity: high
    action: require_payment
    tools: [generate_image]
    payment:
      protocol: x402
      amount: 0.001
      currency: USD
""",
        encoding="utf-8",
    )
    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir)))
    assert (await veto.guard("generate_image", {})).decision == "allow"

    no_economic = Veto.from_rules(
        rules=[
            {
                "id": "gate-tool",
                "name": "Gate Tool",
                "action": "require_payment",
                "tools": ["generate_image"],
                "payment": {"protocol": "x402", "amount": 0.001, "currency": "USD"},
            }
        ],
        log_level="silent",
    )
    assert (await no_economic.guard("generate_image", {})).decision == "deny"


@pytest.mark.asyncio
async def test_shadow_mode_economic_denial_allows_without_deducting(
    tmp_path: Path,
) -> None:
    veto_dir = tmp_path / "veto"
    _write_config(
        veto_dir,
        """economic:
  budgets:
    - scope: session
      limit: 50
      currency: USD
      window: session
  cost_extraction:
    default: arguments.cost
""",
        mode="shadow",
    )
    veto = await Veto.init(VetoOptions(config_dir=str(veto_dir)))

    result = await veto.guard("pay_tool", {"cost": 60})
    assert result.decision == "allow"
    assert result.shadow is True
    assert result.shadow_decision == "deny"
    assert result.economicDenial is not None
    assert result.economicDenial.reason == "budget_exceeded"
    assert veto.get_economic_budget_status().spent == 0  # type: ignore[union-attr]
