//! Generic Agent input notifications.
//!
//! The trusted page may read or request notification permission and ask for
//! one fixed-title alert about a chat it names by ID. It cannot supply text,
//! URLs, or actions. A click focuses the main window and tells a page on a
//! trusted origin which chat to open, so it routes without reloading.

use tauri::Manager;

#[cfg(target_os = "macos")]
mod macos;

pub const OPEN_EVENT: &str = "agent-input-notification-open";
const TITLE: &str = "HackerAI needs your input";
#[cfg(any(target_os = "windows", target_os = "linux"))]
const CHAT_ID_EXTRA: &str = "agentInputChatId";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum Permission {
    Granted,
    Prompt,
    Denied,
    Unavailable,
}

impl Permission {
    fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Prompt => "prompt",
            Self::Denied => "denied",
            Self::Unavailable => "unavailable",
        }
    }
}

const MAX_CHAT_ID_BYTES: usize = 256;

/// One safe `/c/<id>` path segment, matching `isAgentInputChatId` in the web
/// app. Legacy slugs are allowed; delimiters, controls and dot segments are not.
fn is_chat_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CHAT_ID_BYTES
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '#'))
}

fn is_trusted_url(url: &url::Url) -> bool {
    crate::validate_origin(&url.origin().ascii_serialization())
}

pub(crate) fn is_trusted_webview(webview: &tauri::Webview) -> bool {
    webview.label() == "main" && webview.url().is_ok_and(|url| is_trusted_url(&url))
}

fn any_window_focused<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false))
}

fn open_chat<R: tauri::Runtime>(app: &tauri::AppHandle<R>, chat_id: &str) {
    use tauri::Emitter;

    if !is_chat_id(chat_id) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if window.url().is_ok_and(|url| is_trusted_url(&url)) {
        let _ = app.emit_to("main", OPEN_EVENT, chat_id.to_string());
    }
}

/// Installs the click handler once, independent of page reloads.
pub fn init(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    macos::init(app.clone());
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    plugin::init(app);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let _ = app;
}

async fn permission(app: &tauri::AppHandle, request: bool) -> Permission {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos::permission(request).await
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        // Neither platform has a prompt API; the OS decides at display time.
        let _ = request;
        plugin::permission(app).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (app, request);
        Permission::Unavailable
    }
}

async fn deliver(app: &tauri::AppHandle, chat_id: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        macos::show(chat_id).await
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        plugin::show(app, chat_id).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (app, chat_id);
        false
    }
}

#[tauri::command]
pub async fn agent_notification_permission(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    request: bool,
) -> Result<&'static str, String> {
    if !is_trusted_webview(&webview) {
        return Err("Notifications are unavailable for this page".into());
    }
    Ok(permission(&app, request).await.as_str())
}

/// Returns whether an alert was handed to the OS.
#[tauri::command]
pub async fn show_agent_input_notification(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    chat_id: String,
) -> Result<bool, String> {
    if !is_trusted_webview(&webview) || !is_chat_id(&chat_id) {
        return Err("Invalid notification request".into());
    }
    if permission(&app, false).await != Permission::Granted {
        return Ok(false);
    }
    // Checked after the permission read so a window focused meanwhile wins.
    if any_window_focused(&app) {
        return Ok(false);
    }
    Ok(deliver(&app, &chat_id).await)
}

/// Windows and Linux use tauri-plugin-notification from Rust only.
///
/// Limits: Windows reports only the first activation of a toast, so a click
/// from Action Center after the banner times out may not open the chat. Linux
/// depends on the notification daemon supporting default actions.
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod plugin {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tauri_plugin_notification::NotificationExt;

    use super::{open_chat, Permission, CHAT_ID_EXTRA, TITLE};

    static READY: AtomicBool = AtomicBool::new(false);

    pub(super) fn init(app: &tauri::AppHandle) {
        if let Err(error) = app.plugin(tauri_plugin_notification::init()) {
            log::warn!("Agent input notifications unavailable: {error}");
            return;
        }
        let handle = app.clone();
        let registered = app.notification().on_action(move |action| {
            if action.action_id() != "tap" {
                return;
            }
            let chat_id = action
                .notification()
                .and_then(|notification| notification.extra().get(CHAT_ID_EXTRA))
                .and_then(serde_json::Value::as_str);
            if let Some(chat_id) = chat_id {
                open_chat(&handle, chat_id);
            }
        });
        READY.store(registered.is_ok(), Ordering::Release);
    }

    pub(super) async fn permission(app: &tauri::AppHandle) -> Permission {
        if !READY.load(Ordering::Acquire) {
            return Permission::Unavailable;
        }
        #[cfg(target_os = "windows")]
        {
            windows_permission(app).await
        }
        #[cfg(target_os = "linux")]
        {
            let _ = app;
            Permission::Granted
        }
    }

    pub(super) async fn show(app: &tauri::AppHandle, chat_id: &str) -> bool {
        let app = app.clone();
        let chat_id = chat_id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            app.notification()
                .builder()
                .title(TITLE)
                .extra(CHAT_ID_EXTRA, chat_id)
                .show()
                .is_ok()
        })
        .await
        .unwrap_or(false)
    }

    /// The plugin attributes toasts from `target/debug` or `target/release`
    /// to PowerShell, which would be misleading.
    #[cfg(target_os = "windows")]
    fn is_unpackaged_build() -> bool {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
            .is_some_and(|dir| dir.ends_with("target/debug") || dir.ends_with("target/release"))
    }

    #[cfg(target_os = "windows")]
    async fn windows_permission(app: &tauri::AppHandle) -> Permission {
        use windows::core::HSTRING;
        use windows::UI::Notifications::{NotificationSetting, ToastNotificationManager};

        if is_unpackaged_build() {
            return Permission::Unavailable;
        }
        let app_id = HSTRING::from(app.config().identifier.as_str());
        let (sender, receiver) = tokio::sync::oneshot::channel();
        // WinRT calls run on the main (STA) thread the app already initialized.
        let scheduled = app.run_on_main_thread(move || {
            let setting = ToastNotificationManager::CreateToastNotifierWithId(&app_id)
                .and_then(|notifier| notifier.Setting());
            let permission = match setting {
                Ok(setting) if setting == NotificationSetting::Enabled => Permission::Granted,
                Ok(_) => Permission::Denied,
                Err(_) => Permission::Unavailable,
            };
            let _ = sender.send(permission);
        });
        if scheduled.is_err() {
            return Permission::Unavailable;
        }
        receiver.await.unwrap_or(Permission::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_one_safe_path_segment_as_a_chat_id() {
        let longest = "a".repeat(MAX_CHAT_ID_BYTES);
        for value in [
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "legacy_chat-1",
            "release.notes",
            longest.as_str(),
        ] {
            assert!(is_chat_id(value), "{value}");
        }
        let too_long = "é".repeat(MAX_CHAT_ID_BYTES / 2 + 1);
        for value in [
            "",
            ".",
            "..",
            "chat/../settings",
            "https://example.com/c/chat",
            "chat\\settings",
            "chat?next=/settings",
            "chat#top",
            "chat\nid",
            "chat\u{7f}",
            too_long.as_str(),
        ] {
            assert!(!is_chat_id(value), "{value:?}");
        }
    }

    #[test]
    fn trusts_only_allowed_origins() {
        for (url, trusted) in [
            ("https://hackerai.co/c/x", true),
            ("http://localhost:3000/", true),
            ("http://hackerai.co/", false),
            ("https://hackerai.co.evil.test/", false),
            ("tauri://localhost/", false),
        ] {
            assert_eq!(
                is_trusted_url(&url::Url::parse(url).expect("url")),
                trusted,
                "{url}"
            );
        }
    }
}
