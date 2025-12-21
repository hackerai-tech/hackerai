use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const SERVICE_NAME: &str = "hackerai-desktop";
const TOKENS_KEY: &str = "auth-tokens";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LoginInitiated {
    pub state: String,
    pub url: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub has_tokens: bool,
}

/// Initiates the OAuth login flow by generating a state parameter
/// and returning the URL to open in the system browser.
#[tauri::command]
pub async fn start_login(base_url: Option<String>) -> Result<LoginInitiated, String> {
    let state = Uuid::new_v4().to_string();
    let base = base_url.unwrap_or_else(|| "https://hackerai.co".to_string());
    let url = format!("{}/api/desktop-auth/login?state={}", base, state);

    log::info!("Initiating OAuth login with state: {}", &state[..8]);

    Ok(LoginInitiated { state, url })
}

/// Retrieves stored authentication tokens from the OS keychain.
#[tauri::command]
pub async fn get_stored_tokens() -> Result<Option<AuthTokens>, String> {
    let entry = Entry::new(SERVICE_NAME, TOKENS_KEY).map_err(|e| {
        log::error!("Failed to create keyring entry: {}", e);
        format!("Keyring error: {}", e)
    })?;

    match entry.get_password() {
        Ok(json) => {
            let tokens: AuthTokens = serde_json::from_str(&json).map_err(|e| {
                log::error!("Failed to parse stored tokens: {}", e);
                format!("Token parse error: {}", e)
            })?;
            log::debug!("Retrieved stored tokens successfully");
            Ok(Some(tokens))
        }
        Err(keyring::Error::NoEntry) => {
            log::debug!("No stored tokens found");
            Ok(None)
        }
        Err(e) => {
            log::error!("Failed to retrieve tokens: {}", e);
            Err(format!("Keyring error: {}", e))
        }
    }
}

/// Stores authentication tokens in the OS keychain.
#[tauri::command]
pub async fn store_tokens(tokens: AuthTokens) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, TOKENS_KEY).map_err(|e| {
        log::error!("Failed to create keyring entry: {}", e);
        format!("Keyring error: {}", e)
    })?;

    let json = serde_json::to_string(&tokens).map_err(|e| {
        log::error!("Failed to serialize tokens: {}", e);
        format!("Serialization error: {}", e)
    })?;

    entry.set_password(&json).map_err(|e| {
        log::error!("Failed to store tokens: {}", e);
        format!("Keyring error: {}", e)
    })?;

    log::info!("Tokens stored successfully");
    Ok(())
}

/// Refreshes the access token using the refresh token.
#[tauri::command]
pub async fn refresh_tokens(
    refresh_token: String,
    base_url: Option<String>,
) -> Result<AuthTokens, String> {
    let base = base_url.unwrap_or_else(|| "https://hackerai.co".to_string());
    let url = format!("{}/api/desktop-auth/refresh", base);

    log::info!("Refreshing access token");

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| {
            log::error!("Token refresh request failed: {}", e);
            format!("Network error: {}", e)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        log::error!("Token refresh failed with status {}: {}", status, body);
        return Err(format!("Refresh failed: HTTP {}", status));
    }

    let tokens: AuthTokens = response.json().await.map_err(|e| {
        log::error!("Failed to parse refresh response: {}", e);
        format!("Parse error: {}", e)
    })?;

    // Store the new tokens
    store_tokens(tokens.clone()).await?;

    log::info!("Tokens refreshed and stored successfully");
    Ok(tokens)
}

/// Clears stored authentication tokens (logout).
#[tauri::command]
pub async fn logout() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, TOKENS_KEY).map_err(|e| {
        log::error!("Failed to create keyring entry: {}", e);
        format!("Keyring error: {}", e)
    })?;

    // Ignore error if entry doesn't exist
    let _ = entry.delete_credential();
    log::info!("User logged out, tokens cleared");
    Ok(())
}

/// Returns current authentication status.
#[tauri::command]
pub async fn get_auth_status() -> Result<AuthStatus, String> {
    let tokens = get_stored_tokens().await?;
    Ok(AuthStatus {
        authenticated: tokens.is_some(),
        has_tokens: tokens.is_some(),
    })
}

/// Handles incoming deep link URLs for OAuth callbacks.
/// Called from main.rs when a hackerai:// URL is received.
pub fn handle_deep_link(app: &AppHandle, url: &str) {
    log::info!("Handling deep link: {}", &url[..url.len().min(50)]);

    if url.starts_with("hackerai://auth/callback") {
        handle_auth_callback(app, url);
    } else if url.starts_with("hackerai://auth/error") {
        handle_auth_error(app, url);
    } else {
        log::warn!("Unknown deep link scheme: {}", url);
    }
}

fn handle_auth_callback(app: &AppHandle, url: &str) {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            log::error!("Failed to parse callback URL: {}", e);
            let _ = app.emit("auth-error", "Invalid callback URL");
            return;
        }
    };

    let params: std::collections::HashMap<_, _> = parsed.query_pairs().collect();

    let access_token = params.get("access_token");
    let refresh_token = params.get("refresh_token");
    let state = params.get("state");

    match (access_token, refresh_token) {
        (Some(access), Some(refresh)) => {
            let tokens = AuthTokens {
                access_token: access.to_string(),
                refresh_token: refresh.to_string(),
            };

            // Store tokens in keychain
            let entry = match Entry::new(SERVICE_NAME, TOKENS_KEY) {
                Ok(e) => e,
                Err(e) => {
                    log::error!("Failed to create keyring entry: {}", e);
                    let _ = app.emit("auth-error", format!("Keyring error: {}", e));
                    return;
                }
            };

            if let Ok(json) = serde_json::to_string(&tokens) {
                if let Err(e) = entry.set_password(&json) {
                    log::error!("Failed to store tokens: {}", e);
                    let _ = app.emit("auth-error", format!("Failed to store tokens: {}", e));
                    return;
                }
            }

            log::info!(
                "Auth callback successful, state: {}",
                state.map(|s| &s[..s.len().min(8)]).unwrap_or("none")
            );

            // Emit success event to frontend
            let _ = app.emit("auth-success", &tokens);
        }
        _ => {
            log::error!("Missing tokens in callback URL");
            let _ = app.emit("auth-error", "Missing tokens in callback");
        }
    }
}

fn handle_auth_error(app: &AppHandle, url: &str) {
    let parsed = url::Url::parse(url).ok();
    let reason = parsed
        .and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| k == "reason")
                .map(|(_, v)| v.to_string())
        })
        .unwrap_or_else(|| "Unknown error".to_string());

    log::error!("Auth error received: {}", reason);
    let _ = app.emit("auth-error", reason);
}
