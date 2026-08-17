use keyring::v1::{Entry, Error};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "personal-finance-tool";
const USERNAME: &str = "anthropic-api-key";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationState {
    Unverified,
    Ok,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCheck {
    pub state: VerificationState,
    pub checked_at: Option<String>,
    pub detail: Option<String>,
    pub latency_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    Keychain,
    Env,
    None,
}

#[derive(Clone, Debug, Serialize)]
pub struct KeyStatus {
    pub configured: bool,
    pub source: KeySource,
    pub hint: Option<String>,
    pub connection: ConnectionCheck,
}

static CONNECTION: OnceLock<Mutex<ConnectionCheck>> = OnceLock::new();

pub fn never_checked() -> ConnectionCheck {
    ConnectionCheck {
        state: VerificationState::Unverified,
        checked_at: None,
        detail: None,
        latency_ms: None,
    }
}

fn connection() -> &'static Mutex<ConnectionCheck> {
    CONNECTION.get_or_init(|| Mutex::new(never_checked()))
}

pub fn current_connection() -> ConnectionCheck {
    connection()
        .lock()
        .expect("connection check mutex should not be poisoned")
        .clone()
}

pub fn set_connection(check: ConnectionCheck) {
    *connection()
        .lock()
        .expect("connection check mutex should not be poisoned") = check;
}

pub fn reset_connection() {
    set_connection(never_checked());
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

fn env_key() -> Option<String> {
    std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty())
}

pub fn configured_key() -> Result<Option<(String, KeySource)>, String> {
    if let Some(key) = get_key()? {
        return Ok(Some((key, KeySource::Keychain)));
    }

    Ok(env_key().map(|key| (key, KeySource::Env)))
}

pub fn set_key(key: &str) -> Result<KeyStatus, String> {
    entry()?
        .set_password(key)
        .map_err(|e| format!("Unable to save API key in OS keychain: {e}"))?;
    Ok(status())
}

pub fn delete_key() -> Result<KeyStatus, String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => {
            reset_connection();
            Ok(status())
        }
        Err(e) => Err(format!("Unable to delete API key from OS keychain: {e}")),
    }
}

pub fn status() -> KeyStatus {
    match configured_key() {
        Ok(Some((key, source))) => KeyStatus {
            configured: true,
            source,
            hint: hint_for(&key),
            connection: current_connection(),
        },
        Ok(None) | Err(_) => KeyStatus {
            configured: false,
            source: KeySource::None,
            hint: None,
            connection: never_checked(),
        },
    }
}
