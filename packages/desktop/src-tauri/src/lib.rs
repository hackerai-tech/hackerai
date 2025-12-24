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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
