"""Deterministic content/entity extraction helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional


@dataclass
class ExtractedEntities:
    prices: list[float] = field(default_factory=list)
    max_price: float = 0
    min_price: float = 0
    emails: list[str] = field(default_factory=list)
    phone_numbers: list[str] = field(default_factory=list)
    salary_figures: list[float] = field(default_factory=list)
    has_salary_figures: bool = False
    equity_percentages: list[float] = field(default_factory=list)
    has_equity_info: bool = False
    sensitive_terms: list[str] = field(default_factory=list)
    has_sensitive_pii: bool = False
    has_credit_cards: bool = False
    has_gov_ids: bool = False
    has_api_keys: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "prices": self.prices,
            "max_price": self.max_price,
            "min_price": self.min_price,
            "emails": self.emails,
            "phone_numbers": self.phone_numbers,
            "salary_figures": self.salary_figures,
            "has_salary_figures": self.has_salary_figures,
            "equity_percentages": self.equity_percentages,
            "has_equity_info": self.has_equity_info,
            "sensitive_terms": self.sensitive_terms,
            "has_sensitive_pii": self.has_sensitive_pii,
            "has_credit_cards": self.has_credit_cards,
            "has_gov_ids": self.has_gov_ids,
            "has_api_keys": self.has_api_keys,
        }


@dataclass
class ExtractEntitiesOptions:
    max_prices: int = 100
    max_emails: int = 50
    max_phones: int = 50
    max_salary_figures: int = 50
    max_equity_percentages: int = 50
    text_cap: int = 200_000


PRICE_REGEX = re.compile(
    r"(?:[$€£¥₹₩]|(?:USD|EUR|GBP|JPY|INR|CHF|AUD|CAD|CNY)\s?)\s?([\d,]+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
EMAIL_REGEX = re.compile(r"[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,}")
PHONE_REGEX = re.compile(r"(?:\+\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}")
SALARY_REGEX = re.compile(
    r"\b(?:salary\b|salaries\b|compensation\b|comp\b|pay\b|wage\b|wages\b|income\b|earning\b|base\b|total\s*comp\b|ote\b|ctc\b)[:\s]*(?:[$€£¥₹]|(?:USD|EUR|GBP)\s?)?\s?([\d,]+(?:\.\d{1,2})?)\s*(?:k|K|pa|p\.a\.)?",
    re.IGNORECASE,
)
SALARY_AMOUNT_REGEX = re.compile(
    r"(?:[$€£¥₹])\s?([\d,]+(?:\.\d{1,2})?)\s*(?:k|K)\s*(?:\/yr|\/year|per\s*(?:year|annum)|salary|comp|annual|base)",
    re.IGNORECASE,
)
EQUITY_REGEX = re.compile(
    r"([\d.]+)\s*%\s*(?:equity|vesting|options|ownership|stake|shares|stock|rsus?|esop)",
    re.IGNORECASE,
)
GOV_ID_REGEX = re.compile(
    r"\b\d{3}-\d{2}-\d{4}\b|\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b|\b\d{2}-\d{7}\b"
)
CREDIT_CARD_REGEX = re.compile(r"\b(?:\d{4}[-\s]?){3}\d{4}\b")
API_KEY_REGEX = re.compile(r"\b(?:sk|pk|api|key|token|secret|bearer)[-_][a-zA-Z0-9_-]{20,}\b", re.IGNORECASE)
GOV_ID_KEYWORD_REGEX = re.compile(
    r"\b(?:ssn|social\s*security|ein|tax\s*id|national\s*id|identity|passport|license|licence|id\s*number)\b",
    re.IGNORECASE,
)
ZERO_WIDTH_REGEX = re.compile("[\u200b\u200c\u200d\ufeff]")


def _empty_result() -> ExtractedEntities:
    return ExtractedEntities()


def _normalize_unicode(text: str) -> str:
    def fullwidth_digit(match: re.Match[str]) -> str:
        return chr(ord(match.group(0)) - 0xFF10 + 0x30)

    normalized = text.replace("\u00a0", " ")
    normalized = ZERO_WIDTH_REGEX.sub("", normalized)
    return re.sub(r"[\uFF10-\uFF19]", fullwidth_digit, normalized)


def _parse_number(value: str) -> Optional[float]:
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return None


def _dedup(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _passes_luhn(digits: str) -> bool:
    total = 0
    alternate = False
    for raw in reversed(digits):
        n = int(raw)
        if alternate:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        alternate = not alternate
    return total % 10 == 0


def _is_likely_phone_number(value: str) -> bool:
    normalized = value.strip()
    digits = re.sub(r"\D", "", normalized)
    if normalized.startswith("+"):
        return len(digits) >= 8
    return len(digits) >= 10


def _has_gov_id_keyword_nearby(text: str, start: int, length: int) -> bool:
    window_start = max(0, start - 30)
    window_end = min(len(text), start + length + 30)
    return GOV_ID_KEYWORD_REGEX.search(text[window_start:window_end]) is not None


def _normalize_options(
    options: Optional[ExtractEntitiesOptions | Mapping[str, Any]],
) -> ExtractEntitiesOptions:
    if options is None:
        return ExtractEntitiesOptions()
    if isinstance(options, ExtractEntitiesOptions):
        return options

    return ExtractEntitiesOptions(
        max_prices=int(options.get("max_prices", options.get("maxPrices", 100))),
        max_emails=int(options.get("max_emails", options.get("maxEmails", 50))),
        max_phones=int(options.get("max_phones", options.get("maxPhones", 50))),
        max_salary_figures=int(
            options.get("max_salary_figures", options.get("maxSalaryFigures", 50))
        ),
        max_equity_percentages=int(
            options.get(
                "max_equity_percentages",
                options.get("maxEquityPercentages", 50),
            )
        ),
        text_cap=int(options.get("text_cap", options.get("textCap", 200_000))),
    )


def extract_entities(
    text: str,
    options: Optional[ExtractEntitiesOptions | Mapping[str, Any]] = None,
) -> ExtractedEntities:
    """Extract structured entities from arbitrary text."""
    if not text or len(text) < 3:
        return _empty_result()

    opts = _normalize_options(options)
    capped = _normalize_unicode(text[: opts.text_cap])

    prices: list[float] = []
    for match in PRICE_REGEX.finditer(capped):
        price = _parse_number(match.group(1))
        if price is not None and 0 < price < 1_000_000:
            prices.append(price)
        if len(prices) >= opts.max_prices:
            break

    emails = _dedup([match.group(0).lower() for match in EMAIL_REGEX.finditer(capped)])[
        : opts.max_emails
    ]

    phone_numbers = _dedup(
        [
            match.group(0).strip()
            for match in PHONE_REGEX.finditer(capped)
            if _is_likely_phone_number(match.group(0).strip())
        ]
    )[: opts.max_phones]

    salary_figures: list[float] = []
    for regex in (SALARY_REGEX, SALARY_AMOUNT_REGEX):
        for match in regex.finditer(capped):
            amount = _parse_number(match.group(1))
            if amount is None:
                continue
            if "k" in match.group(0).lower():
                amount *= 1000
            if 1000 < amount < 10_000_000:
                salary_figures.append(amount)
            if len(salary_figures) >= opts.max_salary_figures:
                break

    equity_percentages: list[float] = []
    for match in EQUITY_REGEX.finditer(capped):
        try:
            pct = float(match.group(1))
        except ValueError:
            continue
        if 0 < pct <= 100:
            equity_percentages.append(pct)
        if len(equity_percentages) >= opts.max_equity_percentages:
            break

    gov_id_count = sum(
        1
        for match in GOV_ID_REGEX.finditer(capped)
        if _has_gov_id_keyword_nearby(capped, match.start(), len(match.group(0)))
    )
    credit_card_count = sum(
        1
        for match in CREDIT_CARD_REGEX.finditer(capped)
        if _passes_luhn(re.sub(r"\D", "", match.group(0)))
    )
    api_key_count = sum(1 for _ in API_KEY_REGEX.finditer(capped))

    sensitive_terms: list[str] = []
    if salary_figures:
        sensitive_terms.append("salary")
    if equity_percentages:
        sensitive_terms.append("equity")
    if gov_id_count:
        sensitive_terms.append("gov_id")
    if credit_card_count:
        sensitive_terms.append("credit_card")
    if api_key_count:
        sensitive_terms.append("api_key")
    if emails:
        sensitive_terms.append("email")
    if phone_numbers:
        sensitive_terms.append("phone")

    return ExtractedEntities(
        prices=prices,
        max_price=max(prices) if prices else 0,
        min_price=min(prices) if prices else 0,
        emails=emails,
        phone_numbers=phone_numbers,
        salary_figures=salary_figures,
        has_salary_figures=bool(salary_figures),
        equity_percentages=equity_percentages,
        has_equity_info=bool(equity_percentages),
        sensitive_terms=sensitive_terms,
        has_sensitive_pii=bool(sensitive_terms),
        has_credit_cards=credit_card_count > 0,
        has_gov_ids=gov_id_count > 0,
        has_api_keys=api_key_count > 0,
    )


def extractEntities(
    text: str,
    options: Optional[ExtractEntitiesOptions | Mapping[str, Any]] = None,
) -> ExtractedEntities:
    """TypeScript-style alias."""
    return extract_entities(text, options)

