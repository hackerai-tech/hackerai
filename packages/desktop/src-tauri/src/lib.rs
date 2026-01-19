use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60); // 24 hours

fn get_last_update_check_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("last_update_check"))
}

fn should_check_for_updates(app: &tauri::AppHandle) -> bool {
    let Some(file_path) = get_last_update_check_file(app) else {
        return true;
    };

    match fs::read_to_string(&file_path) {
        Ok(content) => {
            let last_check: u64 = content.trim().parse().unwrap_or(0);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            now.saturating_sub(last_check) >= UPDATE_CHECK_INTERVAL.as_secs()
        }
        Err(_) => true,
    }
}

fn save_update_check_timestamp(app: &tauri::AppHandle) {
    let Some(file_path) = get_last_update_check_file(app) else {
        return;
    };

    if let Some(parent) = file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Err(e) = fs::write(&file_path, now.to_string()) {
        log::warn!("Failed to save update check timestamp: {}", e);
    }
}

fn get_allowed_hosts() -> Vec<String> {
    match std::env::var("HACKERAI_ALLOWED_HOSTS") {
        Ok(hosts) => hosts.split(',').map(|s| s.trim().to_string()).collect(),
        Err(_) => vec!["hackerai.co".to_string(), "localhost".to_string()],
    }
}

fn is_valid_token_format(token: &str) -> bool {
    token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit())
}

fn validate_origin(origin: &str) -> bool {
    match url::Url::parse(origin) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or("");
            let scheme = parsed.scheme();
            let allowed_hosts = get_allowed_hosts();
            let is_allowed_host = allowed_hosts.iter().any(|allowed| host == allowed);
            let is_valid_scheme = scheme == "https" || (host == "localhost" && scheme == "http");
            is_allowed_host && is_valid_scheme
        }
        Err(_) => false,
    }
}

fn handle_auth_deep_link(app: &tauri::AppHandle, url: &url::Url) {
    if url.scheme() != "hackerai" {
        return;
    }

    if url.host_str() == Some("auth") || url.path() == "/auth" || url.path() == "auth" {
        match url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v) {
            Some(token) => {
                if !is_valid_token_format(&token) {
                    log::error!("Invalid token format in deep link");
                    return;
                }

                if let Some(window) = app.get_webview_window("main") {
                    // Get and validate origin from deep link query params
                    let origin = url.query_pairs()
                        .find(|(k, _)| k == "origin")
                        .map(|(_, v)| v.to_string())
                        .filter(|o| validate_origin(o))
                        .unwrap_or_else(|| {
                            log::warn!("Deep link has missing or invalid origin, using production");
                            "https://hackerai.co".to_string()
                        });

                    let encoded_token: String = url::form_urlencoded::byte_serialize(token.as_bytes()).collect();
                    let callback_url = format!("{}/desktop-callback?token={}", origin, encoded_token);
                    log::info!("Navigating to desktop callback (token: {}...)", &token[..8.min(token.len())]);

                    match callback_url.parse() {
                        Ok(parsed_url) => {
                            if let Err(e) = window.navigate(parsed_url) {
                                log::error!("Failed to navigate to callback URL: {}", e);
                                // Try to navigate to error page
                                let error_url = format!("{}/login?error=navigation_failed", origin);
                                if let Ok(error_parsed) = error_url.parse() {
                                    let _ = window.navigate(error_parsed);
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("Invalid callback URL format: {}", e);
                        }
                    }
                }
            }
            None => {
                if let Some((_, error)) = url.query_pairs().find(|(k, _)| k == "error") {
                    log::error!("Auth deep link received with error: {}", error);
                } else {
                    log::warn!("Auth deep link received without token: {:?}", url);
                }
            }
        }
    }
}

async fn check_for_updates(app: tauri::AppHandle, silent: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            if silent {
                log::warn!("Auto-update check failed to get updater: {}", e);
            } else {
                log::error!("Failed to get updater: {}", e);
                let _ = app.dialog()
                    .message(format!("Failed to check for updates: {}", e))
                    .kind(MessageDialogKind::Error)
                    .title("Update Error")
                    .blocking_show();
            }
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("Update available: {}", version);

            let should_update = app.dialog()
                .message(format!(
                    "A new version ({}) is available. Would you like to update now?",
                    version
                ))
                .title("Update Available")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancel)
                .blocking_show();

            if should_update {
                log::info!("User accepted update to version {}", version);
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    log::error!("Failed to install update: {}", e);
                    let _ = app.dialog()
                        .message(format!("Failed to install update: {}", e))
                        .kind(MessageDialogKind::Error)
                        .title("Update Error")
                        .blocking_show();
                } else {
                    log::info!("Update installed successfully");
                    let restart_now = app.dialog()
                        .message("Update installed successfully. Restart now to apply changes?")
                        .kind(MessageDialogKind::Info)
                        .title("Update Complete")
                        .buttons(MessageDialogButtons::OkCancelCustom("Restart Now".into(), "Later".into()))
                        .blocking_show();
                    if restart_now {
                        app.restart();
                    }
                }
            }
        }
        Ok(None) => {
            if silent {
                log::info!("No updates available (auto-check)");
            } else {
                log::info!("No updates available");
                let _ = app.dialog()
                    .message("You're running the latest version.")
                    .kind(MessageDialogKind::Info)
                    .title("No Updates")
                    .blocking_show();
            }
        }
        Err(e) => {
            if silent {
                log::warn!("Auto-update check failed: {}", e);
            } else {
                log::error!("Failed to check for updates: {}", e);
                let _ = app.dialog()
                    .message(format!("Failed to check for updates: {}", e))
                    .kind(MessageDialogKind::Error)
                    .title("Update Error")
                    .blocking_show();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Handle deep links passed as CLI args (Linux/Windows)
            log::info!("Single instance callback with args: {:?}", args);
            for arg in args.iter().skip(1) {
                if let Ok(url) = url::Url::parse(arg) {
                    if url.scheme() == "hackerai" {
                        log::info!("Processing deep link from CLI arg: {}", arg);
                        handle_auth_deep_link(app, &url);
                    }
                }
            }
            // Focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Register deep links at runtime for Linux/Windows
                // This is required for AppImage and non-installed Windows builds
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                {
                    if let Err(e) = app.deep_link().register_all() {
                        log::warn!("Failed to register deep links: {}", e);
                    } else {
                        log::info!("Deep links registered successfully");
                    }
                }

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    log::info!("Deep link received: {:?}", urls);

                    for url in urls {
                        handle_auth_deep_link(&handle, &url);
                    }
                });
            }
            // Check for updates on every launch
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                log::info!("Running update check on launch");
                save_update_check_timestamp(&handle);
                check_for_updates(handle.clone(), true).await;

                // Then check every hour if 24h has passed (for long-running sessions)
                loop {
                    tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                    if should_check_for_updates(&handle) {
                        log::info!("Running scheduled update check (24h interval)");
                        save_update_check_timestamp(&handle);
                        check_for_updates(handle.clone(), true).await;
                    }
                }
            });

            log::info!("HackerAI Desktop initialized");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
