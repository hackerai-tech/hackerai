//! UNUserNotificationCenter bridge. The notification plugin's macOS backend
//! always reports permission as granted, so this reads and requests the real
//! authorization and handles clicks through one retained delegate.

use std::ptr::NonNull;
use std::sync::{Arc, Mutex, Once, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use objc2_06::rc::Retained;
use objc2_06::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2_06::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tokio::sync::oneshot;

use super::{any_window_focused, is_chat_id, open_chat, Permission, TITLE};

/// Bounds system callbacks that do not wait for the user.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const IDENTIFIER_PREFIX: &str = "co.hackerai.agent-input.";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static INSTALL_DELEGATE: Once = Once::new();

/// `<prefix><chat UUID>.<32 hex nonce>`, unique per alert.
fn notification_identifier(chat_id: &str) -> String {
    format!(
        "{IDENTIFIER_PREFIX}{chat_id}.{}",
        uuid::Uuid::new_v4().simple()
    )
}

fn chat_id_from_identifier(identifier: &str) -> Option<&str> {
    let (chat_id, nonce) = identifier
        .strip_prefix(IDENTIFIER_PREFIX)?
        .split_once('.')?;
    let valid_nonce = nonce.len() == 32 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit());
    (is_chat_id(chat_id) && valid_nonce).then_some(chat_id)
}

/// UNUserNotificationCenter aborts outside an app bundle (e.g. `tauri dev`).
fn center() -> Option<Retained<UNUserNotificationCenter>> {
    let bundle = NSBundle::mainBundle();
    let has_identifier = bundle
        .bundleIdentifier()
        .is_some_and(|identifier| !identifier.to_string().is_empty());
    let is_app_bundle = bundle.bundlePath().to_string().ends_with(".app");
    (has_identifier && is_app_bundle).then(UNUserNotificationCenter::currentNotificationCenter)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "HackerAIAgentInputNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// Shown while HackerAI is active only if none of its windows has focus,
        /// for example when its window is minimized.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let focused = APP.get().is_none_or(any_window_focused);
            #[allow(deprecated)] // Banner and List need macOS 11; Desktop supports 10.15.
            let options = if focused {
                UNNotificationPresentationOptions::empty()
            } else {
                UNNotificationPresentationOptions::Alert
            };
            completion_handler.call((options,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let action = response.actionIdentifier();
            if action.isEqualToString(unsafe { UNNotificationDefaultActionIdentifier }) {
                let identifier = response.notification().request().identifier().to_string();
                if let (Some(app), Some(chat_id)) =
                    (APP.get(), chat_id_from_identifier(&identifier))
                {
                    open_chat(app, chat_id);
                }
            }
            completion_handler.call(());
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

pub(super) fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
    INSTALL_DELEGATE.call_once(|| {
        let Some(center) = center() else {
            log::info!("Agent input notifications unavailable outside an app bundle");
            return;
        };
        let delegate = NotificationDelegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly.
        std::mem::forget(delegate);
    });
}

fn map_status(status: UNAuthorizationStatus) -> Permission {
    match status {
        UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => {
            Permission::Granted
        }
        UNAuthorizationStatus::NotDetermined => Permission::Prompt,
        UNAuthorizationStatus::Denied => Permission::Denied,
        _ => Permission::Unavailable,
    }
}

type Slot<T> = Arc<Mutex<Option<oneshot::Sender<T>>>>;

/// Completion blocks must be `Fn`; the first call wins.
fn one_shot<T>() -> (Slot<T>, oneshot::Receiver<T>) {
    let (sender, receiver) = oneshot::channel();
    (Arc::new(Mutex::new(Some(sender))), receiver)
}

fn send<T>(slot: &Mutex<Option<oneshot::Sender<T>>>, value: T) {
    if let Some(sender) = slot.lock().ok().and_then(|mut slot| slot.take()) {
        let _ = sender.send(value);
    }
}

// Starters release their Objective-C objects before the caller awaits, so the
// command futures stay `Send`. The center copies each completion block.

fn start_status_read() -> Option<oneshot::Receiver<Permission>> {
    let center = center()?;
    let (slot, receiver) = one_shot();
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        send(&slot, map_status(status));
    });
    center.getNotificationSettingsWithCompletionHandler(&block);
    Some(receiver)
}

fn start_authorization_request() -> Option<oneshot::Receiver<bool>> {
    let center = center()?;
    let (slot, receiver) = one_shot();
    let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        send(&slot, granted.as_bool());
    });
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &block);
    Some(receiver)
}

fn start_delivery(chat_id: &str) -> Option<oneshot::Receiver<bool>> {
    let center = center()?;
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(TITLE));
    let identifier = NSString::from_str(&notification_identifier(chat_id));
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);
    let (slot, receiver) = one_shot();
    let block = RcBlock::new(move |error: *mut NSError| {
        send(&slot, error.is_null());
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
    Some(receiver)
}

async fn current_status() -> Permission {
    let Some(receiver) = start_status_read() else {
        return Permission::Unavailable;
    };
    match tokio::time::timeout(CALLBACK_TIMEOUT, receiver).await {
        Ok(Ok(permission)) => permission,
        _ => Permission::Unavailable,
    }
}

pub(super) async fn permission(request: bool) -> Permission {
    let status = current_status().await;
    if !request || status != Permission::Prompt {
        return status;
    }
    // Unbounded: the system prompt waits for the user's answer.
    if let Some(receiver) = start_authorization_request() {
        let _ = receiver.await;
    }
    current_status().await
}

pub(super) async fn show(chat_id: &str) -> bool {
    let Some(receiver) = start_delivery(chat_id) else {
        return false;
    };
    matches!(
        tokio::time::timeout(CALLBACK_TIMEOUT, receiver).await,
        Ok(Ok(true))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn gives_each_alert_its_own_routable_identifier() {
        let first = notification_identifier(CHAT_ID);
        let second = notification_identifier(CHAT_ID);
        assert_ne!(first, second);
        assert_eq!(chat_id_from_identifier(&first), Some(CHAT_ID));
    }

    #[test]
    fn routes_only_identifiers_this_module_created() {
        let nonce = "0123456789abcdef0123456789abcdef";
        for identifier in [
            CHAT_ID.to_string(),
            format!("{IDENTIFIER_PREFIX}{CHAT_ID}"),
            format!("{IDENTIFIER_PREFIX}{CHAT_ID}.short"),
            format!("{IDENTIFIER_PREFIX}not-a-chat.{nonce}"),
            format!("{IDENTIFIER_PREFIX}{CHAT_ID}.{nonce}.extra"),
            format!("other.{CHAT_ID}.{nonce}"),
        ] {
            assert_eq!(chat_id_from_identifier(&identifier), None, "{identifier}");
        }
    }
}
