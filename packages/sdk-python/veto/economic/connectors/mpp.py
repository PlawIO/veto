"""Stripe MPP connector."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any, Optional

from veto.economic.connectors._helpers import get_header
from veto.economic.types import EconomicContext, EconomicDenialDetails


def _number(value: Any) -> Optional[float]:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    numeric = float(value)
    return numeric if math.isfinite(numeric) else None


def _extract_session_data(obj: Mapping[str, Any]) -> Optional[Mapping[str, Any]]:
    raw_session = obj.get("mpp_session", obj)
    if not isinstance(raw_session, Mapping):
        return None
    token = raw_session.get("session_token")
    if not isinstance(token, str) or not token:
        return None
    return raw_session


class MPPConnector:
    protocol = "mpp"
    protocol_version = "2026.03"
    protocolVersion = protocol_version

    def extract(self, response: Any) -> Optional[EconomicContext]:
        mpp_session = get_header(response, "x-mpp-session")
        if mpp_session:
            cost_header = get_header(response, "x-mpp-cost")
            cost = 0.0
            if cost_header is not None:
                try:
                    cost = float(cost_header)
                except ValueError:
                    return None
                if not math.isfinite(cost) or cost < 0:
                    return None

            currency = get_header(response, "x-mpp-currency") or "USD"
            payer = get_header(response, "x-mpp-payer")
            return EconomicContext(
                cost=cost,
                currency=currency.upper(),
                payer=payer,
                protocol="mpp",
                protocol_metadata={"session_token": mpp_session},
            )

        if not isinstance(response, Mapping):
            return None

        session = _extract_session_data(response)
        if session is None:
            return None

        session_cost = _number(session.get("cost"))
        session_currency = session.get("currency")
        session_payer = session.get("payer")
        return EconomicContext(
            cost=session_cost if session_cost is not None else 0,
            currency=session_currency.upper()
            if isinstance(session_currency, str)
            else "USD",
            payer=session_payer if isinstance(session_payer, str) else None,
            protocol="mpp",
            protocol_metadata={
                "session_token": session["session_token"],
                "spending_limit": _number(session.get("spending_limit")),
                "session_spent": _number(session.get("spent")),
            },
        )


def create_mpp_connector() -> MPPConnector:
    return MPPConnector()


def createMPPConnector() -> MPPConnector:
    return create_mpp_connector()


def build_mpp_connector_error(error: str) -> EconomicDenialDetails:
    return EconomicDenialDetails(
        reason="connector_error",
        cost=0,
        currency="USD",
        budget_scope="session",
        budget_limit=0,
        budget_spent=0,
        budget_remaining=0,
        connector_name="mpp",
        raw_error=error,
    )


def buildMPPConnectorError(error: str) -> EconomicDenialDetails:
    return build_mpp_connector_error(error)
