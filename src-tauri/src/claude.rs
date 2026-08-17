use chrono::{SecondsFormat, Utc};
use reqwest::{header, StatusCode};
use serde_json::Value;
use std::time::Instant;

use crate::keychain::{self, ConnectionCheck, VerificationState};

const BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().build().map_err(|e| {
        format!(
            "Unable to create Anthropic client: {}",
            redact(&e.to_string())
        )
    })
}

fn api_key() -> Result<String, String> {
    if let Some((key, _source)) = keychain::configured_key().map_err(|e| redact(&e))? {
        return Ok(key);
    }

    Err("Anthropic API key is not configured.".to_string())
}

fn with_headers(request: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    request
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("x-api-key", key)
        .header(header::CONTENT_TYPE, "application/json")
}

fn redact_with_key(message: &str, key: &str) -> String {
    let without_exact_key = if key.is_empty() {
        message.to_owned()
    } else {
        message.replace(key, "[REDACTED]")
    };
    redact(&without_exact_key)
}

fn checked_at() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn ok_check(latency_ms: u64) -> ConnectionCheck {
    ConnectionCheck {
        state: VerificationState::Ok,
        checked_at: Some(checked_at()),
        detail: None,
        latency_ms: Some(latency_ms),
    }
}

fn failed_check(detail: String, latency_ms: Option<u64>) -> ConnectionCheck {
    ConnectionCheck {
        state: VerificationState::Failed,
        checked_at: Some(checked_at()),
        detail: Some(redact(&detail)),
        latency_ms,
    }
}

fn status_detail(status: StatusCode, body: &str, key: &str) -> String {
    let body = redact_with_key(body, key);

    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return format!(
            "Anthropic rejected the API key (HTTP {status}). Check the key and try again."
        );
    }

    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        return format!(
            "Anthropic service is unavailable or rate-limited (HTTP {status}). Try again later or check account limits: {body}"
        );
    }

    format!("Anthropic request failed with status {status}: {body}")
}

pub fn redact(message: &str) -> String {
    let bytes = message.as_bytes();
    let mut redacted = String::with_capacity(message.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index..].starts_with(b"sk-ant-") {
            let start = index;
            index += b"sk-ant-".len();
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric()
                    || bytes[index] == b'_'
                    || bytes[index] == b'-')
            {
                index += 1;
            }

            if index > start + b"sk-ant-".len() {
                redacted.push_str("[REDACTED]");
            } else {
                redacted.push_str("sk-ant-");
            }
            continue;
        }

        let ch = message[index..]
            .chars()
            .next()
            .expect("index always points at a valid UTF-8 boundary");
        redacted.push(ch);
        index += ch.len_utf8();
    }

    redacted
}

async fn parse_response(response: reqwest::Response, key: &str) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|e| {
        format!(
            "Unable to read Anthropic response: {}",
            redact(&e.to_string())
        )
    })?;

    if status.is_success() {
        let parsed = serde_json::from_str(&body).map_err(|e| {
            format!(
                "Anthropic returned invalid JSON: {}",
                redact(&e.to_string())
            )
        })?;
        Ok(parsed)
    } else {
        let detail = status_detail(status, &body, key);
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            keychain::set_connection(failed_check(detail.clone(), None));
        }
        Err(detail)
    }
}

pub async fn list_models_with_key(key: &str) -> Result<Value, String> {
    let started = Instant::now();
    let response = with_headers(
        client()?
            .get(format!("{BASE_URL}/v1/models"))
            .query(&[("limit", "100")]),
        key,
    )
    .send()
    .await
    .map_err(|e| {
        format!(
            "Unable to reach Anthropic: {}",
            redact_with_key(&e.to_string(), key)
        )
    })?;

    let value = parse_response(response, key).await?;
    keychain::set_connection(ok_check(
        started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    ));
    Ok(value)
}

pub async fn list_models() -> Result<Value, String> {
    let key = api_key()?;
    list_models_with_key(&key).await
}

pub async fn send_message(body: Value) -> Result<Value, String> {
    let key = api_key()?;
    let started = Instant::now();
    let response = with_headers(
        client()?
            .post(format!("{BASE_URL}/v1/messages"))
            .json(&body),
        &key,
    )
    .send()
    .await
    .map_err(|e| {
        format!(
            "Unable to reach Anthropic: {}",
            redact_with_key(&e.to_string(), &key)
        )
    })?;

    let value = parse_response(response, &key).await?;
    keychain::set_connection(ok_check(
        started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    ));
    Ok(value)
}

pub async fn verify_connection_with_key(key: &str) -> Result<ConnectionCheck, String> {
    let started = Instant::now();
    let response = match with_headers(
        client()?
            .get(format!("{BASE_URL}/v1/models"))
            .query(&[("limit", "1")]),
        key,
    )
    .send()
    .await
    {
        Ok(response) => response,
        Err(e) => {
            let latency_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
            return Ok(failed_check(
                format!(
                    "Unable to reach Anthropic; network or service unavailable: {}",
                    redact_with_key(&e.to_string(), key)
                ),
                Some(latency_ms),
            ));
        }
    };

    let latency_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
    let status = response.status();
    let body = response.text().await.map_err(|e| {
        format!(
            "Unable to read Anthropic response: {}",
            redact_with_key(&e.to_string(), key)
        )
    })?;

    if status.is_success() {
        Ok(ok_check(latency_ms))
    } else {
        Ok(failed_check(
            status_detail(status, &body, key),
            Some(latency_ms),
        ))
    }
}

pub async fn verify_connection() -> Result<ConnectionCheck, String> {
    let key = api_key()?;
    let check = verify_connection_with_key(&key).await?;
    keychain::set_connection(check.clone());
    Ok(check)
}

#[cfg(test)]
mod tests {
    use super::{redact, status_detail};
    use crate::keychain::{ConnectionCheck, KeySource, KeyStatus, VerificationState};
    use reqwest::StatusCode;
    use serde_json::json;

    #[test]
    fn redacts_anthropic_keys() {
        let message = "upstream echoed sk-ant-api03_abc-DEF123 and sk-ant-x";

        assert_eq!(redact(message), "upstream echoed [REDACTED] and [REDACTED]");
    }

    #[test]
    fn leaves_non_keys_alone() {
        assert_eq!(
            redact("not an Anthropic key: sk-ant-"),
            "not an Anthropic key: sk-ant-"
        );
    }

    #[test]
    fn redacts_keys_echoed_by_upstream_errors() {
        let key = "sk-ant-api03_secret-KEY123";
        let message = format!("upstream echoed {key} in an error");

        assert_eq!(redact(&message), "upstream echoed [REDACTED] in an error");
        assert_eq!(
            super::redact_with_key(&message, key),
            "upstream echoed [REDACTED] in an error"
        );
    }

    #[test]
    fn key_status_serializes_with_connection_check_shape() {
        let status = KeyStatus {
            configured: true,
            source: KeySource::Keychain,
            hint: Some("1234".to_string()),
            connection: ConnectionCheck {
                state: VerificationState::Unverified,
                checked_at: None,
                detail: None,
                latency_ms: None,
            },
        };

        assert_eq!(
            serde_json::to_value(status).expect("status should serialize"),
            json!({
                "configured": true,
                "source": "keychain",
                "hint": "1234",
                "connection": {
                    "state": "unverified",
                    "checkedAt": null,
                    "detail": null,
                    "latencyMs": null
                }
            })
        );
    }

    #[test]
    fn distinguishes_rejected_key_from_unavailable_service() {
        let key = "sk-ant-api03_secret-KEY123";
        let rejected = status_detail(StatusCode::UNAUTHORIZED, "bad key", key);
        let unavailable = status_detail(StatusCode::SERVICE_UNAVAILABLE, "try later", key);

        assert!(rejected.contains("rejected the API key"));
        assert!(!rejected.contains("unavailable"));
        assert!(unavailable.contains("service is unavailable"));
        assert!(!unavailable.contains("rejected the API key"));
    }
}
