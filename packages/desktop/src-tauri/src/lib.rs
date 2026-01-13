use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
fn navigate_back(window: &tauri::WebviewWindow) {
    use objc2_web_kit::WKWebView;

    if let Err(e) = window.with_webview(|webview| unsafe {
        let wk_webview: &WKWebView = &*webview.inner().cast();
        if wk_webview.canGoBack() {
            wk_webview.goBack();
        }
    }) {
        log::warn!("Failed to navigate back: {}", e);
    }
}

#[cfg(not(target_os = "macos"))]
fn navigate_back(_window: &tauri::WebviewWindow) {}

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

async fn check_for_updates_silent(app: tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            log::warn!("Auto-update check failed to get updater: {}", e);
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
                    let _ = app.dialog()
                        .message("Update installed. Please restart the application.")
                        .kind(MessageDialogKind::Info)
                        .title("Update Complete")
                        .blocking_show();
                }
            }
        }
        Ok(None) => {
            log::info!("No updates available (auto-check)");
        }
        Err(e) => {
            log::warn!("Auto-update check failed: {}", e);
        }
    }
}

async fn check_for_updates(app: tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            log::error!("Failed to get updater: {}", e);
            let _ = app.dialog()
                .message(format!("Failed to check for updates: {}", e))
                .kind(MessageDialogKind::Error)
                .title("Update Error")
                .blocking_show();
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
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
                    let _ = app.dialog()
                        .message("Update installed. Please restart the application.")
                        .kind(MessageDialogKind::Info)
                        .title("Update Complete")
                        .blocking_show();
                }
            }
        }
        Ok(None) => {
            log::info!("No updates available");
            let _ = app.dialog()
                .message("You're running the latest version.")
                .kind(MessageDialogKind::Info)
                .title("No Updates")
                .blocking_show();
        }
        Err(e) => {
            log::error!("Failed to check for updates: {}", e);
            let _ = app.dialog()
                .message(format!("Failed to check for updates: {}", e))
                .kind(MessageDialogKind::Error)
                .title("Update Error")
                .blocking_show();
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
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    log::info!("Deep link received: {:?}", urls);

                    for url in urls {
                        handle_auth_deep_link(&handle, &url);
                    }
                });
            }
            let go_back_item = MenuItemBuilder::new("Go Back")
                .id("go_back")
                .accelerator("CmdOrCtrl+[")
                .build(app)?;

            let check_updates_item = MenuItemBuilder::new("Check for Updates...")
                .id("check_updates")
                .build(app)?;

            let navigation_menu = SubmenuBuilder::new(app, "Navigation")
                .item(&go_back_item)
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&check_updates_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&navigation_menu, &help_menu])
                .build()?;

            app.set_menu(menu)?;

            // Auto-check for updates on launch
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates_silent(handle).await;
            });

            log::info!("HackerAI Desktop initialized with menus");
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "go_back" {
                if let Some(window) = app.get_webview_window("main") {
                    navigate_back(&window);
                }
            } else if event.id().as_ref() == "check_updates" {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
