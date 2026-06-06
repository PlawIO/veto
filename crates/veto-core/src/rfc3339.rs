use crate::error::{VetoCoreError, VetoCoreResult};

pub fn parse_rfc3339_epoch_seconds(value: &str) -> VetoCoreResult<i64> {
    Ok(parse_rfc3339_epoch_millis(value)? / 1000)
}

pub fn parse_rfc3339_epoch_millis(value: &str) -> VetoCoreResult<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return invalid_timestamp(value);
    }
    require_byte(bytes, 4, b'-', value)?;
    require_byte(bytes, 7, b'-', value)?;
    require_byte(bytes, 10, b'T', value)?;
    require_byte(bytes, 13, b':', value)?;
    require_byte(bytes, 16, b':', value)?;

    let year = parse_digits(value, 0, 4)?;
    let month = parse_digits(value, 5, 7)?;
    let day = parse_digits(value, 8, 10)?;
    let hour = parse_digits(value, 11, 13)?;
    let minute = parse_digits(value, 14, 16)?;
    let mut second = parse_digits(value, 17, 19)?;
    let mut index = 19;
    let mut millis = 0_i64;

    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if start == index {
            return invalid_timestamp(value);
        }
        let fraction = &value[start..index];
        let mut padded = fraction.chars().take(3).collect::<String>();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded
            .parse::<i64>()
            .map_err(|_| artifact_timestamp_error(value))?;
    }

    let offset_minutes = match bytes.get(index) {
        Some(b'Z') if index + 1 == bytes.len() => 0,
        Some(b'+') | Some(b'-') if index + 6 == bytes.len() => {
            require_byte(bytes, index + 3, b':', value)?;
            let sign = if bytes[index] == b'+' { 1 } else { -1 };
            let hour = parse_digits(value, index + 1, index + 3)?;
            let minute = parse_digits(value, index + 4, index + 6)?;
            if hour > 23 || minute > 59 {
                return invalid_timestamp(value);
            }
            sign * (hour * 60 + minute)
        }
        _ => return invalid_timestamp(value),
    };

    if year < 1
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return invalid_timestamp(value);
    }
    if second == 60 {
        if hour != 23 || minute != 59 || day != days_in_month(year, month) || offset_minutes != 0 {
            return invalid_timestamp(value);
        }
        second = 59;
    }

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Ok(seconds * 1000 + millis)
}

fn require_byte(bytes: &[u8], index: usize, expected: u8, original: &str) -> VetoCoreResult<()> {
    if bytes.get(index) == Some(&expected) {
        Ok(())
    } else {
        invalid_timestamp(original)
    }
}

fn parse_digits(value: &str, start: usize, end: usize) -> VetoCoreResult<i64> {
    let slice = value
        .get(start..end)
        .ok_or_else(|| artifact_timestamp_error(value))?;
    if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
        return invalid_timestamp(value);
    }
    slice
        .parse::<i64>()
        .map_err(|_| artifact_timestamp_error(value))
}

fn invalid_timestamp<T>(value: &str) -> VetoCoreResult<T> {
    Err(artifact_timestamp_error(value))
}

fn artifact_timestamp_error(value: &str) -> VetoCoreError {
    VetoCoreError::InvalidArtifact {
        path: "$.timestamp".to_string(),
        message: format!("must be an RFC 3339 timestamp; got {value:?}"),
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month_prime + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::parse_rfc3339_epoch_seconds;

    #[test]
    fn parses_offsets() {
        assert_eq!(
            parse_rfc3339_epoch_seconds("2026-06-04T12:00:00+03:00").unwrap(),
            parse_rfc3339_epoch_seconds("2026-06-04T09:00:00Z").unwrap(),
        );
    }

    #[test]
    fn rejects_bad_calendar_dates() {
        assert!(parse_rfc3339_epoch_seconds("2026-02-31T12:00:00Z").is_err());
        assert!(parse_rfc3339_epoch_seconds("2026-06-04T12:00:00").is_err());
    }
}
