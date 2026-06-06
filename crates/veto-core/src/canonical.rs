use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{VetoCoreError, VetoCoreResult};

pub fn canonicalize(value: &Value) -> VetoCoreResult<String> {
    match value {
        Value::Null => Ok("null".to_string()),
        Value::Bool(value) => Ok(if *value { "true" } else { "false" }.to_string()),
        Value::Number(number) => {
            if number.as_f64().is_some_and(|value| !value.is_finite()) {
                return Err(VetoCoreError::Canonicalization(
                    "non-finite numbers cannot be committed".to_string(),
                ));
            }
            Ok(number.to_string())
        }
        Value::String(value) => serde_json::to_string(value).map_err(Into::into),
        Value::Array(values) => {
            let mut out = String::from("[");
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&canonicalize(item)?);
            }
            out.push(']');
            Ok(out)
        }
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key)?);
                out.push(':');
                out.push_str(&canonicalize(&map[*key])?);
            }
            out.push('}');
            Ok(out)
        }
    }
}

pub fn canonicalize_serializable<T: Serialize>(value: &T) -> VetoCoreResult<String> {
    canonicalize(&serde_json::to_value(value)?)
}

pub fn sha256_prefixed(input: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(input.as_ref());
    let mut hex = String::with_capacity(71);
    hex.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

pub fn compute_commitment(value: &Value) -> VetoCoreResult<String> {
    Ok(sha256_prefixed(canonicalize(value)?.as_bytes()))
}

pub(crate) fn compute_commitment_serializable<T: Serialize>(value: &T) -> VetoCoreResult<String> {
    Ok(sha256_prefixed(
        canonicalize_serializable(value)?.as_bytes(),
    ))
}
