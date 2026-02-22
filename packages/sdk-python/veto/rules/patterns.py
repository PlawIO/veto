"""
Common sensitive-data regex patterns for output redaction rules.

Reference only: patterns are not applied automatically.
"""

OUTPUT_PATTERN_SSN = r"\b\d{3}-\d{2}-\d{4}\b"
OUTPUT_PATTERN_CREDIT_CARD = r"\b(?:\d[ -]*?){13,16}\b"
OUTPUT_PATTERN_OPENAI_API_KEY = r"\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b"
OUTPUT_PATTERN_GITHUB_API_KEY = (
    r"(?:\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|"
    r"\bgithub_pat_[A-Za-z0-9_]{82}\b)"
)
OUTPUT_PATTERN_AWS_API_KEY = (
    r"\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b"
)
OUTPUT_PATTERN_EMAIL = r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
OUTPUT_PATTERN_US_PHONE = (
    r"\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b"
)

OUTPUT_PATTERNS = {
    "ssn": OUTPUT_PATTERN_SSN,
    "credit_card": OUTPUT_PATTERN_CREDIT_CARD,
    "openai_api_key": OUTPUT_PATTERN_OPENAI_API_KEY,
    "github_api_key": OUTPUT_PATTERN_GITHUB_API_KEY,
    "aws_api_key": OUTPUT_PATTERN_AWS_API_KEY,
    "email": OUTPUT_PATTERN_EMAIL,
    "us_phone": OUTPUT_PATTERN_US_PHONE,
}
