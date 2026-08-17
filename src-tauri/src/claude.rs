use reqwest::{header, StatusCode};
use serde_json::Value;

use crate::keychain;

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
    if let Some(key) = keychain::get_key().map_err(|e| redact(&e))? {
        return Ok(key);
    }

    std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Anthropic API key is not configured.".to_string())
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
        serde_json::from_str(&body).map_err(|e| {
            format!(
                "Anthropic returned invalid JSON: {}",
                redact(&e.to_string())
            )
        })
    } else if status == StatusCode::UNAUTHORIZED {
        Err("Anthropic rejected the API key. Check the key and try again.".to_string())
    } else {
        Err(format!(
            "Anthropic request failed with status {status}: {}",
            redact_with_key(&body, key)
        ))
    }
}

pub async fn list_models_with_key(key: &str) -> Result<Value, String> {
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

    parse_response(response, key).await
}

pub async fn list_models() -> Result<Value, String> {
    let key = api_key()?;
    list_models_with_key(&key).await
}

pub async fn send_message(body: Value) -> Result<Value, String> {
    let key = api_key()?;
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

    parse_response(response, &key).await
}

#[cfg(test)]
mod tests {
    use super::redact;

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
}
