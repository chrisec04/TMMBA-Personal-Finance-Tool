// Personal Finance Tool
//
// The Rust shell owns the Anthropic boundary because the API key should never enter the
// webview. The frontend can ask for model data and message completions, but only this
// crate reads credentials from the OS keychain and attaches them to outbound requests.

use tauri::Manager;

mod claude;
mod keychain;

pub use keychain::KeyStatus;

#[tauri::command]
fn claude_key_status() -> KeyStatus {
    keychain::status()
}

#[tauri::command]
async fn claude_key_set(key: String) -> Result<KeyStatus, String> {
    let key = key.trim().to_owned();
    if key.is_empty() {
        return Err("Anthropic API key cannot be empty.".to_string());
    }

    let check = claude::verify_connection_with_key(&key).await?;
    if check.state != keychain::VerificationState::Ok {
        return Err(check
            .detail
            .unwrap_or_else(|| "Anthropic connection verification failed.".to_string()));
    }

    keychain::set_key(&key)?;
    keychain::set_connection(check);
    Ok(keychain::status())
}

#[tauri::command]
fn claude_key_clear() -> Result<KeyStatus, String> {
    keychain::delete_key()
}

#[tauri::command]
async fn claude_list_models() -> Result<serde_json::Value, String> {
    claude::list_models().await
}

#[tauri::command]
async fn claude_send_message(body: serde_json::Value) -> Result<serde_json::Value, String> {
    claude::send_message(body).await
}

#[tauri::command]
async fn claude_verify_connection() -> Result<KeyStatus, String> {
    claude::verify_connection().await?;
    Ok(keychain::status())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            claude_key_status,
            claude_key_set,
            claude_key_clear,
            claude_verify_connection,
            claude_list_models,
            claude_send_message
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Personal Finance Tool");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
