"""Google AP2 connector."""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional

from veto.economic.connectors._helpers import get_header
from veto.economic.types import EconomicContext, EconomicDenialDetails


def _number(value: Any) -> Optional[float]:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    numeric = float(value)
    return numeric if math.isfinite(numeric) else None


def _parse_number(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    try:
        numeric = float(value)
    except ValueError:
        return None
    return numeric if math.isfinite(numeric) else None


def _is_expired(expires_at: str) -> bool:
    candidate = expires_at.strip()
    if candidate.endswith("Z"):
        candidate = f"{candidate[:-1]}+00:00"
    try:
        expiry = datetime.fromisoformat(candidate)
    except ValueError:
        return True
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    return expiry < datetime.now(timezone.utc)


def _exceeds_spending_cap(
    cost: float,
    spending_cap: Optional[float],
    spent: Optional[float],
) -> bool:
    if spending_cap is None:
        return False
    return cost > (spending_cap - (spent or 0))


def _extract_mandate_data(obj: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    raw_mandate = obj.get("ap2_mandate", obj.get("mandate", obj))
    if not isinstance(raw_mandate, Mapping):
        return None
    mandate_id = raw_mandate.get("mandate_id")
    if not isinstance(mandate_id, str) or not mandate_id:
        return None
    return raw_mandate


class AP2Connector:
    protocol = "ap2"
    protocol_version = "2026.03"
    protocolVersion = protocol_version

    def extract(self, response: Any) -> Optional[EconomicContext]:
        mandate_id = get_header(response, "x-ap2-mandate-id")
        if mandate_id:
            expires_at = get_header(response, "x-ap2-expires")
            if expires_at and _is_expired(expires_at):
                return None

            cost = _parse_number(get_header(response, "x-ap2-cost")) or 0
            if cost < 0:
                return None

            spending_cap = _parse_number(get_header(response, "x-ap2-spending-cap"))
            spent = _parse_number(get_header(response, "x-ap2-spent"))
            if _exceeds_spending_cap(cost, spending_cap, spent):
                return None

            currency = get_header(response, "x-ap2-currency") or "USD"
            signer = get_header(response, "x-ap2-signer")
            return EconomicContext(
                cost=cost,
                currency=currency.upper(),
                payer=signer,
                protocol="ap2",
                protocol_metadata={
                    "mandate_id": mandate_id,
                    "spending_cap": spending_cap,
                    "mandate_spent": spent,
                    "expires_at": expires_at,
                },
            )

        if not isinstance(response, Mapping):
            return None

        mandate = _extract_mandate_data(response)
        if mandate is None:
            return None

        expires_at = mandate.get("expires_at")
        if isinstance(expires_at, str) and _is_expired(expires_at):
            return None

        cost = _number(mandate.get("cost")) or 0
        if cost < 0:
            return None

        spending_cap = _number(mandate.get("spending_cap"))
        spent = _number(mandate.get("spent"))
        if _exceeds_spending_cap(cost, spending_cap, spent):
            return None

        mandate_currency = mandate.get("currency")
        signer = mandate.get("signer")
        categories = mandate.get("categories")
        return EconomicContext(
            cost=cost,
            currency=mandate_currency.upper()
            if isinstance(mandate_currency, str)
            else "USD",
            payer=signer if isinstance(signer, str) else None,
            protocol="ap2",
            protocol_metadata={
                "mandate_id": mandate["mandate_id"],
                "spending_cap": spending_cap,
                "mandate_spent": spent,
                "categories": [item for item in categories if isinstance(item, str)]
                if isinstance(categories, list)
                else None,
                "expires_at": expires_at if isinstance(expires_at, str) else None,
            },
        )


def create_ap2_connector() -> AP2Connector:
    return AP2Connector()


def createAP2Connector() -> AP2Connector:
    return create_ap2_connector()


def build_ap2_connector_error(error: str) -> EconomicDenialDetails:
    return EconomicDenialDetails(
        reason="connector_error",
        cost=0,
        currency="USD",
        budget_scope="session",
        budget_limit=0,
        budget_spent=0,
        budget_remaining=0,
        connector_name="ap2",
        raw_error=error,
    )


def buildAP2ConnectorError(error: str) -> EconomicDenialDetails:
    return build_ap2_connector_error(error)
