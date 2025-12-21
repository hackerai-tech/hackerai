pub mod auth;
pub mod docker;

#[allow(unused_imports)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(docker::SandboxState::default())
        .invoke_handler(tauri::generate_handler![
            // Auth commands
            auth::start_login,
            auth::get_stored_tokens,
            auth::store_tokens,
            auth::refresh_tokens,
            auth::logout,
            auth::get_auth_status,
            // Docker commands
            docker::check_docker,
            docker::check_sandbox_image,
            docker::pull_sandbox_image,
            docker::start_sandbox,
            docker::stop_sandbox,
            docker::get_sandbox_status,
        ])
        .setup(|app| {
            // Register deep link handler
            let handle = app.handle().clone();

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        auth::handle_deep_link(&handle, url.as_str());
                    }
                });
            }

            log::info!("HackerAI Desktop initialized");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
