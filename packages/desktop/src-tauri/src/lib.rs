use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Manager;

#[cfg(target_os = "macos")]
fn navigate_back(window: &tauri::WebviewWindow) {
    use objc2_web_kit::WKWebView;

    let _ = window.with_webview(|webview| unsafe {
        let wk_webview: &WKWebView = &*webview.inner().cast();
        if wk_webview.canGoBack() {
            wk_webview.goBack();
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn navigate_back(_window: &tauri::WebviewWindow) {}

const ALLOWED_ORIGINS: &[&str] = &["https://hackerai.co", "http://localhost:3000"];

fn validate_origin(origin: &str) -> bool {
    ALLOWED_ORIGINS.iter().any(|allowed| origin.starts_with(allowed))
}

fn handle_auth_deep_link(app: &tauri::AppHandle, url: &url::Url) {
    if url.scheme() != "hackerai" {
        return;
    }

    if url.host_str() == Some("auth") || url.path() == "/auth" || url.path() == "auth" {
        match url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v) {
            Some(token) => {
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

                    let callback_url = format!("{}/desktop-callback?token={}", origin, token);
                    log::info!("Navigating to desktop callback: {}", callback_url);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
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

            let navigation_menu = SubmenuBuilder::new(app, "Navigation")
                .item(&go_back_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&navigation_menu])
                .build()?;

            app.set_menu(menu)?;

            log::info!("HackerAI Desktop initialized with navigation menu");
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "go_back" {
                if let Some(window) = app.get_webview_window("main") {
                    navigate_back(&window);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
