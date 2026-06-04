const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(y) ? 29 : 28;
    default:
      return 0;
  }
}

export interface ParsedRfc3339 {
  epochMs: number;
  canonical: string;
  offset: string;
}

export class Rfc3339ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Rfc3339ParseError";
  }
}

function utcEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

export function parseRfc3339Strict(value: string): ParsedRfc3339 {
  if (typeof value !== "string") {
    throw new Rfc3339ParseError(`timestamp must be a string; got ${typeof value}`);
  }
  const m = RFC3339_RE.exec(value);
  if (!m) {
    throw new Rfc3339ParseError(
      `timestamp must be RFC 3339 (YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH:MM)); got "${value}"`,
    );
  }

  const [, yearStr, monthStr, dayStr, hourStr, minStr, secStr, fracStr, offset] = m;
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10);
  const day = parseInt(dayStr!, 10);
  const hour = parseInt(hourStr!, 10);
  const minute = parseInt(minStr!, 10);
  let second = parseInt(secStr!, 10);

  if (year < 1) throw new Rfc3339ParseError(`year must be >= 0001; got ${yearStr}`);
  if (month < 1 || month > 12) throw new Rfc3339ParseError(`month must be 01..12; got ${monthStr}`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Rfc3339ParseError(`day ${dayStr} out of range for ${yearStr}-${monthStr}`);
  }
  if (hour > 23) throw new Rfc3339ParseError(`hour must be 00..23; got ${hourStr}`);
  if (minute > 59) throw new Rfc3339ParseError(`minute must be 00..59; got ${minStr}`);
  if (second > 60) throw new Rfc3339ParseError(`second must be 00..60; got ${secStr}`);

  if (second === 60) {
    if (hour !== 23 || minute !== 59) {
      throw new Rfc3339ParseError(
        `leap second :60 is only legal at 23:59:60; got ${hourStr}:${minStr}:${secStr}`,
      );
    }
    if (day !== daysInMonth(year, month)) {
      throw new Rfc3339ParseError(
        `leap second :60 is only legal on the last day of the UTC month; got ${yearStr}-${monthStr}-${dayStr}`,
      );
    }
    if (offset !== "Z" && offset !== "+00:00" && offset !== "-00:00") {
      throw new Rfc3339ParseError(`leap second :60 is only legal at UTC offset; got ${offset}`);
    }
    second = 59;
  }

  let offsetMinutes = 0;
  if (offset !== "Z") {
    const sign = offset!.startsWith("+") ? 1 : -1;
    const oHour = parseInt(offset!.slice(1, 3), 10);
    const oMin = parseInt(offset!.slice(4, 6), 10);
    if (oHour > 23) throw new Rfc3339ParseError(`offset hour must be 00..23; got ${offset}`);
    if (oMin > 59) throw new Rfc3339ParseError(`offset minute must be 00..59; got ${offset}`);
    offsetMinutes = sign * (oHour * 60 + oMin);
  }

  const utcMs = utcEpochMs(year, month, day, hour, minute, second);
  const fracMs = fracStr ? Math.floor(Number("0." + fracStr) * 1000) : 0;
  const epochMs = utcMs + fracMs - offsetMinutes * 60 * 1000;
  const d = new Date(epochMs);
  const pad = (n: number, w: number = 2) => n.toString().padStart(w, "0");
  const fracCanon = d.getUTCMilliseconds();
  const fracPart = fracCanon === 0 ? "" : "." + pad(fracCanon, 3);
  const canonical =
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${fracPart}Z`;

  return { epochMs, canonical, offset: offset! };
}

export function isValidRfc3339(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    parseRfc3339Strict(value);
    return true;
  } catch {
    return false;
  }
}
