use keyring::v1::{Entry, Error};
use serde::Serialize;

const SERVICE: &str = "personal-finance-tool";
const USERNAME: &str = "anthropic-api-key";

#[derive(Clone, Debug, Serialize)]
pub struct KeyStatus {
    pub configured: bool,
    pub hint: Option<String>,
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, USERNAME).map_err(|e| format!("Unable to open OS keychain: {e}"))
}

fn hint_for(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    if chars.is_empty() {
        None
    } else {
        Some(chars[chars.len().saturating_sub(4)..].iter().collect())
    }
}

pub fn get_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(key) if key.trim().is_empty() => Ok(None),
        Ok(key) => Ok(Some(key)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Unable to read API key from OS keychain: {e}")),
    }
}

pub fn set_key(key: &str) -> Result<KeyStatus, String> {
    entry()?
        .set_password(key)
        .map_err(|e| format!("Unable to save API key in OS keychain: {e}"))?;
    Ok(status())
}

pub fn delete_key() -> Result<KeyStatus, String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(status()),
        Err(e) => Err(format!("Unable to delete API key from OS keychain: {e}")),
    }
}

pub fn status() -> KeyStatus {
    match get_key() {
        Ok(Some(key)) => KeyStatus {
            configured: true,
            hint: hint_for(&key),
        },
        Ok(None) | Err(_) => KeyStatus {
            configured: false,
            hint: None,
        },
    }
}
