"""Strict RFC 3339 / ISO 8601 parser — Python mirror of rfc3339.ts.

Matches TypeScript behavior component-for-component so the two SDKs agree on
every timestamp. Rejects impossible dates (2026-02-31), out-of-range offsets
(+24:00, +00:60), and precision a human couldn't express portably
(fractional >6 digits).
"""

from __future__ import annotations

import calendar
import datetime as _dt
import re
from dataclasses import dataclass

_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$"
)


class Rfc3339ParseError(ValueError):
    """Raised when a timestamp string fails strict RFC 3339 parsing."""


@dataclass
class ParsedRfc3339:
    epoch_ms: int
    canonical: str
    offset: str


def parse_rfc3339_strict(value: str) -> ParsedRfc3339:
    if not isinstance(value, str):
        raise Rfc3339ParseError(
            f"timestamp must be a string; got {type(value).__name__}"
        )
    m = _RE.match(value)
    if not m:
        raise Rfc3339ParseError(
            f"timestamp must be RFC 3339 (YYYY-MM-DDTHH:MM:SS[.ffffff](Z|\u00b1HH:MM)); got {value!r}"
        )
    year_s, month_s, day_s, hour_s, min_s, sec_s, frac_s, offset = m.groups()
    year = int(year_s)
    month = int(month_s)
    day = int(day_s)
    hour = int(hour_s)
    minute = int(min_s)
    second = int(sec_s)

    if year < 1:
        raise Rfc3339ParseError(f"year must be >= 0001; got {year_s}")
    if not 1 <= month <= 12:
        raise Rfc3339ParseError(f"month must be 01..12; got {month_s}")
    max_day = calendar.monthrange(year, month)[1]
    if not 1 <= day <= max_day:
        raise Rfc3339ParseError(f"day {day_s} out of range for {year_s}-{month_s}")
    if hour > 23:
        raise Rfc3339ParseError(f"hour must be 00..23; got {hour_s}")
    if minute > 59:
        raise Rfc3339ParseError(f"minute must be 00..59; got {min_s}")
    if second > 60:
        raise Rfc3339ParseError(f"second must be 00..60; got {sec_s}")
    if second == 60:
        # RFC 3339 §5.6: leap seconds occur ONLY at 23:59:60 UTC on the last
        # day of a UTC month. Anything else silently collapsing to :59 makes
        # two semantically-distinct payloads hash-equal after canonicalization.
        if hour != 23 or minute != 59:
            raise Rfc3339ParseError(
                f"leap second :60 is only legal at 23:59:60; got {hour_s}:{min_s}:{sec_s}"
            )
        second = 59  # clamp ONLY at 23:59:60

    offset_minutes = 0
    if offset != "Z":
        sign = 1 if offset.startswith("+") else -1
        o_hour = int(offset[1:3])
        o_min = int(offset[4:6])
        if o_hour > 23:
            raise Rfc3339ParseError(f"offset hour must be 00..23; got {offset}")
        if o_min > 59:
            raise Rfc3339ParseError(f"offset minute must be 00..59; got {offset}")
        offset_minutes = sign * (o_hour * 60 + o_min)

    utc_naive = _dt.datetime(year, month, day, hour, minute, second, tzinfo=_dt.timezone.utc)
    # Use floor (not round) so TS and Python produce the same epoch_ms for
    # every fractional input. Math.floor vs Python round() caused a 1ms
    # drift at boundaries like .123500 — flagged by adversarial codex pass.
    import math as _math
    frac_ms = _math.floor(float("0." + frac_s) * 1000) if frac_s else 0
    epoch_ms = int(utc_naive.timestamp() * 1000) + frac_ms - offset_minutes * 60 * 1000

    # Round-trip canonical UTC form with no trailing-zero fraction.
    dt_utc = _dt.datetime.fromtimestamp(epoch_ms / 1000, tz=_dt.timezone.utc)
    micro_ms = dt_utc.microsecond // 1000
    frac_part = f".{micro_ms:03d}" if micro_ms else ""
    canonical = (
        f"{dt_utc.year:04d}-{dt_utc.month:02d}-{dt_utc.day:02d}"
        f"T{dt_utc.hour:02d}:{dt_utc.minute:02d}:{dt_utc.second:02d}"
        f"{frac_part}Z"
    )

    return ParsedRfc3339(epoch_ms=epoch_ms, canonical=canonical, offset=offset)


def is_valid_rfc3339(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parse_rfc3339_strict(value)
        return True
    except Rfc3339ParseError:
        return False
