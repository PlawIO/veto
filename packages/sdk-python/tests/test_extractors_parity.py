from veto import extractEntities, extract_entities


def test_extracts_prices_emails_and_phones() -> None:
    result = extract_entities(
        "Contact USER@example.com or +1 (415) 555-2671. Total: USD 1,234.56"
    )

    assert result.prices == [1234.56]
    assert result.max_price == 1234.56
    assert result.min_price == 1234.56
    assert result.emails == ["user@example.com"]
    assert result.phone_numbers == ["+1 (415) 555-2671"]
    assert "email" in result.sensitive_terms
    assert "phone" in result.sensitive_terms


def test_extracts_salary_equity_and_sensitive_flags() -> None:
    result = extract_entities(
        "Salary: $150,000 per year, total comp $200K annual, "
        "2.5% equity vesting. SSN: 123-45-6789. "
        "Card: 4111 1111 1111 1111. Use api_key_abcdefghijklmnopqrstuvwxyz123."
    )

    assert 150000 in result.salary_figures
    assert 200000 in result.salary_figures
    assert result.has_salary_figures is True
    assert result.equity_percentages == [2.5]
    assert result.has_equity_info is True
    assert result.has_gov_ids is True
    assert result.has_credit_cards is True
    assert result.has_api_keys is True
    assert result.has_sensitive_pii is True


def test_limits_normalizes_unicode_and_aliases_ts_name() -> None:
    result = extractEntities("Price:\u00a0$\u200b１９９.99 and $50", {"maxPrices": 1})

    assert result.prices == [199.99]
    assert result.to_dict()["max_price"] == 199.99


def test_avoids_common_false_positives() -> None:
    result = extract_entities("Just some plain text about dogs and cats.")

    assert result.has_credit_cards is False
    assert result.has_gov_ids is False
    assert result.has_sensitive_pii is False
