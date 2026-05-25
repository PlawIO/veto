"""x402 protocol connector."""

from __future__ import annotations

import math
from typing import Any, Optional

from veto.economic.connectors._helpers import get_header, get_status
from veto.economic.types import EconomicContext, EconomicDenialDetails

STABLECOIN_TOKENS = {"USDC", "USDT", "DAI", "BUSD"}


def _parse_x_payment_header(header: str) -> Optional[dict[str, str]]:
    parts = [part.strip() for part in header.split(";") if part.strip()]
    result: dict[str, str] = {}
    for part in parts:
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip().lower()
        value = value.strip()
        if key and value:
            result[key] = value

    required = {"price", "token", "chain", "recipient"}
    return result if required.issubset(result) else None


def _token_to_usd(price: str, token: str) -> Optional[float]:
    try:
        amount = float(price)
    except ValueError:
        return None
    if not math.isfinite(amount) or amount < 0:
        return None
    if token.upper() in STABLECOIN_TOKENS:
        return amount
    return None


def _parse_from_header(header: str) -> Optional[EconomicContext]:
    instruction = _parse_x_payment_header(header)
    if instruction is None:
        return None

    cost_usd = _token_to_usd(instruction["price"], instruction["token"])
    if cost_usd is None:
        return None

    return EconomicContext(
        cost=cost_usd,
        currency="USD",
        protocol="x402",
        protocol_metadata={
            "token": instruction["token"],
            "chain": instruction["chain"],
            "recipient": instruction["recipient"],
            "raw_price": instruction["price"],
        },
    )


class X402Connector:
    protocol = "x402"
    protocol_version = "2.0"

    # TypeScript export uses protocolVersion; keep alias for direct parity.
    protocolVersion = protocol_version

    def extract(self, response: Any) -> Optional[EconomicContext]:
        if get_status(response) != 402:
            return None
        payment_header = get_header(response, "x-payment")
        if not payment_header:
            return None
        return _parse_from_header(payment_header)

    def wrap_fetch(self, fetch_fn: Any) -> Any:
        async def wrapped(*args: Any, **kwargs: Any) -> Any:
            response = await fetch_fn(*args, **kwargs)
            context = self.extract(response)
            if context is not None:
                setattr(response, "__vetoEconomicContext", context)
            return response

        return wrapped

    def wrapFetch(self, fetch_fn: Any) -> Any:
        return self.wrap_fetch(fetch_fn)


def create_x402_connector() -> X402Connector:
    return X402Connector()


def createX402Connector() -> X402Connector:
    return create_x402_connector()


def build_x402_connector_error(error: str) -> EconomicDenialDetails:
    return EconomicDenialDetails(
        reason="connector_error",
        cost=0,
        currency="USD",
        budget_scope="session",
        budget_limit=0,
        budget_spent=0,
        budget_remaining=0,
        connector_name="x402",
        raw_error=error,
    )


def buildX402ConnectorError(error: str) -> EconomicDenialDetails:
    return build_x402_connector_error(error)

