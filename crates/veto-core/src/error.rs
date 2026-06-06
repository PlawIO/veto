use std::fmt::{Display, Formatter};

pub type VetoCoreResult<T> = Result<T, VetoCoreError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VetoCoreError {
    Canonicalization(String),
    InvalidArtifact { path: String, message: String },
    InvalidReceipt { path: String, message: String },
    Verification(String),
    Json(String),
}

impl Display for VetoCoreError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Canonicalization(message) => write!(f, "canonicalization failed: {message}"),
            Self::InvalidArtifact { path, message } => write!(f, "{path}: {message}"),
            Self::InvalidReceipt { path, message } => write!(f, "{path}: {message}"),
            Self::Verification(message) => write!(f, "verification failed: {message}"),
            Self::Json(message) => write!(f, "json error: {message}"),
        }
    }
}

impl std::error::Error for VetoCoreError {}

impl From<serde_json::Error> for VetoCoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value.to_string())
    }
}
