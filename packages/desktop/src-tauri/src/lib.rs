use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri::State;
use tauri_plugin_updater::UpdaterExt;
use tokio::process::Command as TokioCommand;

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

// ── Desktop Terminal Execution ──────────────────────────────────────────────

/// Tracks background processes spawned by the desktop sandbox
struct BackgroundProcesses {
    pids: Mutex<HashMap<u32, String>>, // pid -> command
}

#[derive(serde::Serialize)]
struct CommandOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    pid: Option<u32>,
    duration_ms: u64,
}

#[derive(serde::Serialize)]
struct OsInfo {
    platform: String,
    arch: String,
    release: String,
    hostname: String,
}

/// Get the platform shell and flag for executing commands
fn get_shell() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        ("powershell.exe", "-Command")
    } else {
        ("/bin/bash", "-c")
    }
}

/// Truncate output using 25% head + 75% tail strategy (matches @hackerai/local)
fn truncate_output(content: &str, max_size: usize) -> String {
    if content.len() <= max_size {
        return content.to_string();
    }

    let head_size = max_size / 4;
    let tail_size = max_size - head_size;
    let marker = "\n\n--- OUTPUT TRUNCATED ---\n\n";

    let head: String = content.chars().take(head_size).collect();
    let tail: String = content
        .chars()
        .rev()
        .take(tail_size)
        .collect::<String>()
        .chars()
        .rev()
        .collect();

    format!("{}{}{}", head, marker, tail)
}

const MAX_OUTPUT_SIZE: usize = 12288; // ~4096 tokens

/// Execute a shell command and return stdout, stderr, exit code
#[tauri::command]
async fn execute_command(
    command: String,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    let (shell, flag) = get_shell();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30000));
    let start = std::time::Instant::now();

    let mut cmd = TokioCommand::new(shell);
    cmd.arg(flag).arg(&command);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }

    if let Some(ref vars) = env {
        for (key, value) in vars {
            cmd.env(key, value);
        }
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn process: {}", e))?;
    let pid = child.id();

    let result = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            // Timeout - try to kill the process
            if let Some(p) = pid {
                #[cfg(unix)]
                {
                    unsafe { libc::kill(p as i32, libc::SIGTERM); }
                    // Give it 2s then SIGKILL
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(2));
                        unsafe { libc::kill(p as i32, libc::SIGKILL); }
                    });
                }
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(&["/PID", &p.to_string(), "/F"])
                        .spawn();
                }
            }
            format!("Command timed out after {}ms", timeout.as_millis())
        })?
        .map_err(|e| format!("Command execution failed: {}", e))?;

    let duration = start.elapsed();
    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();

    Ok(CommandOutput {
        stdout: truncate_output(&stdout, MAX_OUTPUT_SIZE),
        stderr: truncate_output(&stderr, MAX_OUTPUT_SIZE),
        exit_code: result.status.code().unwrap_or(-1),
        pid,
        duration_ms: duration.as_millis() as u64,
    })
}

/// Execute a command in the background, returning the PID
#[tauri::command]
async fn execute_command_background(
    command: String,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
    state: State<'_, BackgroundProcesses>,
) -> Result<CommandOutput, String> {
    let (shell, flag) = get_shell();
    let start = std::time::Instant::now();

    let mut cmd = TokioCommand::new(shell);
    cmd.arg(flag).arg(&command);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }

    if let Some(ref vars) = env {
        for (key, value) in vars {
            cmd.env(key, value);
        }
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn background process: {}", e))?;
    let pid = child.id();

    if let Some(p) = pid {
        if let Ok(mut pids) = state.pids.lock() {
            pids.insert(p, command.clone());
        }
    }

    let duration = start.elapsed();

    Ok(CommandOutput {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: 0,
        pid,
        duration_ms: duration.as_millis() as u64,
    })
}

/// Kill a background process by PID
#[tauri::command]
async fn kill_process(
    pid: u32,
    state: State<'_, BackgroundProcesses>,
) -> Result<bool, String> {
    if let Ok(mut pids) = state.pids.lock() {
        pids.remove(&pid);
    }

    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result != 0 {
            // Try SIGKILL
            unsafe { libc::kill(pid as i32, libc::SIGKILL); }
        }
        Ok(true)
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/F"])
            .status()
            .map_err(|e| format!("Failed to kill process: {}", e))?;
        Ok(status.success())
    }
}

/// Get OS information for the desktop environment
#[tauri::command]
fn get_os_info() -> OsInfo {
    OsInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        release: os_release(),
        hostname: hostname(),
    }
}

fn os_release() -> String {
    #[cfg(target_os = "linux")]
    {
        fs::read_to_string("/proc/version")
            .unwrap_or_default()
            .split_whitespace()
            .nth(2)
            .unwrap_or("unknown")
            .to_string()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/C", "ver"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        std::process::Command::new("hostname")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|_| "desktop".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "desktop".to_string())
    }
    #[cfg(not(any(unix, windows)))]
    {
        "desktop".to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackgroundProcesses {
            pids: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            execute_command,
            execute_command_background,
            kill_process,
            get_os_info,
        ])
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
