//! Bounded native lifecycle evidence for investigating renderer loss.
//!
//! One fixed-schema receipt in app data records whether the previous native
//! process reached the normal exit callback and the last closed-enum WebKit
//! web process termination reason it observed, so the evidence survives the
//! user closing and reopening the app. It holds only a random launch ID, that
//! flag and that reason: never URLs, paths, commands, targets or panic
//! payloads. An unclean exit is not evidence of a crash; forced quit, SIGKILL,
//! power loss, restart and installer handoff all leave the same receipt. Every
//! failure here degrades to `unknown` and never prevents startup.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const RECEIPT_FILE: &str = "native-lifecycle.json";
const RECEIPT_VERSION: u8 = 1;
const MAX_RECEIPT_BYTES: u64 = 256;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    version: u8,
    launch_id: String,
    clean_exit: bool,
    web_process_termination: WebProcessTermination,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreviousExit {
    Clean,
    Unclean,
    /// No receipt: first launch with this build, or app data was cleared.
    None,
    /// The receipt or app data was unreadable or invalid.
    Unknown,
}

/// Only WebKitGTK reports a reason; other platforms always report `none`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WebProcessTermination {
    None,
    Crashed,
    MemoryLimit,
    Api,
    Unknown,
}

#[cfg(target_os = "linux")]
impl From<webkit2gtk::WebProcessTerminationReason> for WebProcessTermination {
    fn from(reason: webkit2gtk::WebProcessTerminationReason) -> Self {
        use webkit2gtk::WebProcessTerminationReason as Reason;
        match reason {
            Reason::Crashed => Self::Crashed,
            Reason::ExceededMemoryLimit => Self::MemoryLimit,
            Reason::TerminatedByApi => Self::Api,
            _ => Self::Unknown,
        }
    }
}

/// Fixed fields surfaced through `get_desktop_os_info`.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifecycleSnapshot {
    launch_id: String,
    previous_exit: PreviousExit,
    /// The last reason the previous native process recorded, if any.
    previous_web_process_termination: WebProcessTermination,
    page_generation: u64,
    /// The last reason observed by this native process.
    web_process_termination: WebProcessTermination,
}

pub(crate) struct LifecycleDiagnostics {
    launch_id: String,
    previous_exit: PreviousExit,
    previous_web_process_termination: WebProcessTermination,
    directory: Option<PathBuf>,
    // Held while writing the receipt so termination and exit writes serialize.
    web_process_termination: Mutex<WebProcessTermination>,
}

impl LifecycleDiagnostics {
    /// Consume the previous receipt, then record this launch as running. The
    /// previous receipt is removed first so a failed write can never leave an
    /// older clean exit to be attributed to this launch.
    pub(crate) fn start(directory: Option<PathBuf>) -> Self {
        let launch_id = uuid::Uuid::new_v4().simple().to_string();
        let (previous_exit, previous_web_process_termination) = match &directory {
            Some(directory) => take_previous(directory),
            None => (PreviousExit::Unknown, WebProcessTermination::Unknown),
        };
        let diagnostics = Self {
            launch_id,
            previous_exit,
            previous_web_process_termination,
            directory,
            web_process_termination: Mutex::new(WebProcessTermination::None),
        };
        if !diagnostics.write(false, WebProcessTermination::None) {
            log::warn!("Native lifecycle receipt unavailable; continuing startup");
        }
        diagnostics
    }

    /// Persist immediately: the user may close the app before any later write.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn record_web_process_termination(&self, reason: WebProcessTermination) {
        let mut current = self.current();
        *current = reason;
        if !self.write(false, reason) {
            log::warn!("Native lifecycle receipt could not record web process termination");
        }
    }

    /// Only the normal exit callback calls this.
    pub(crate) fn record_clean_exit(&self) {
        let current = self.current();
        if !self.write(true, *current) {
            log::warn!("Native lifecycle receipt could not record a clean exit");
        }
    }

    pub(crate) fn snapshot(&self, page_generation: u64) -> LifecycleSnapshot {
        LifecycleSnapshot {
            launch_id: self.launch_id.clone(),
            previous_exit: self.previous_exit,
            previous_web_process_termination: self.previous_web_process_termination,
            page_generation,
            web_process_termination: *self.current(),
        }
    }

    fn current(&self) -> std::sync::MutexGuard<'_, WebProcessTermination> {
        self.web_process_termination
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn write(&self, clean_exit: bool, termination: WebProcessTermination) -> bool {
        let Some(directory) = &self.directory else {
            return false;
        };
        write_receipt(
            directory,
            &Receipt {
                version: RECEIPT_VERSION,
                launch_id: self.launch_id.clone(),
                clean_exit,
                web_process_termination: termination,
            },
        )
        .is_ok()
    }
}

fn valid_launch_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn take_previous(directory: &Path) -> (PreviousExit, WebProcessTermination) {
    const UNKNOWN: (PreviousExit, WebProcessTermination) =
        (PreviousExit::Unknown, WebProcessTermination::Unknown);
    let path = directory.join(RECEIPT_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (PreviousExit::None, WebProcessTermination::None)
        }
        Err(_) => return UNKNOWN,
    };
    // Never follow a link or read an unbounded corrupted receipt.
    let receipt = (metadata.is_file() && metadata.len() <= MAX_RECEIPT_BYTES)
        .then(|| fs::read(&path).ok())
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Receipt>(&bytes).ok())
        .filter(|receipt| {
            receipt.version == RECEIPT_VERSION && valid_launch_id(&receipt.launch_id)
        });
    if fs::remove_file(&path).is_err() {
        return UNKNOWN;
    }
    match receipt {
        Some(receipt) => (
            if receipt.clean_exit {
                PreviousExit::Clean
            } else {
                PreviousExit::Unclean
            },
            receipt.web_process_termination,
        ),
        None => UNKNOWN,
    }
}

fn write_receipt(directory: &Path, receipt: &Receipt) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".native-lifecycle-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(receipt)?)?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join(RECEIPT_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!(
            "hackerai-native-lifecycle-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    fn previous(diagnostics: &LifecycleDiagnostics) -> (PreviousExit, WebProcessTermination) {
        let snapshot = diagnostics.snapshot(0);
        (
            snapshot.previous_exit,
            snapshot.previous_web_process_termination,
        )
    }

    #[test]
    fn lifecycle_diagnostics_distinguish_first_unclean_and_clean_previous_exits() {
        let dir = scratch();
        let first = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(
            previous(&first),
            (PreviousExit::None, WebProcessTermination::None)
        );
        assert!(valid_launch_id(&first.launch_id));

        // The first process never reached the exit callback (e.g. SIGKILL).
        let second = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(
            previous(&second),
            (PreviousExit::Unclean, WebProcessTermination::None)
        );
        assert_ne!(first.launch_id, second.launch_id);
        second.record_clean_exit();

        let third = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(third.snapshot(0).previous_exit, PreviousExit::Clean);
        // A clean receipt is consumed: crashing now must not read as clean.
        let fourth = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(fourth.snapshot(0).previous_exit, PreviousExit::Unclean);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lifecycle_diagnostics_retain_web_process_termination_across_restart() {
        let dir = scratch();
        let renderer_lost = LifecycleDiagnostics::start(Some(dir.clone()));
        renderer_lost.record_web_process_termination(WebProcessTermination::Crashed);
        assert_eq!(
            renderer_lost.snapshot(0).web_process_termination,
            WebProcessTermination::Crashed
        );
        // The user closes the blank window; no exit callback is guaranteed.
        drop(renderer_lost);

        let reopened = LifecycleDiagnostics::start(Some(dir.clone()));
        let snapshot = reopened.snapshot(0);
        assert_eq!(snapshot.previous_exit, PreviousExit::Unclean);
        assert_eq!(
            snapshot.previous_web_process_termination,
            WebProcessTermination::Crashed
        );
        // The current process has observed nothing yet.
        assert_eq!(
            snapshot.web_process_termination,
            WebProcessTermination::None
        );

        // A later reason survives a clean exit as well.
        reopened.record_web_process_termination(WebProcessTermination::MemoryLimit);
        reopened.record_clean_exit();
        let after_clean_exit = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(
            previous(&after_clean_exit),
            (PreviousExit::Clean, WebProcessTermination::MemoryLimit)
        );
        // Each launch starts its own receipt: an older reason is not carried on.
        let next = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(
            previous(&next),
            (PreviousExit::Unclean, WebProcessTermination::None)
        );
        let size = fs::metadata(dir.join(RECEIPT_FILE)).unwrap().len();
        assert!(size <= MAX_RECEIPT_BYTES, "receipt grew to {size} bytes");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lifecycle_diagnostics_reject_invalid_receipts_without_blocking_startup() {
        let dir = scratch();
        fs::create_dir_all(&dir).unwrap();
        let receipt = dir.join(RECEIPT_FILE);
        let id = "0".repeat(32);
        for bytes in [
            b"partial json".to_vec(),
            vec![b' '; MAX_RECEIPT_BYTES as usize + 1],
            // Unknown fields could smuggle URLs, paths or commands.
            format!(
                r#"{{"version":1,"launchId":"{id}","cleanExit":true,"webProcessTermination":"none","url":"https://example.test"}}"#
            )
            .into_bytes(),
            br#"{"version":1,"launchId":"/home/user/project","cleanExit":true,"webProcessTermination":"none"}"#.to_vec(),
            format!(
                r#"{{"version":2,"launchId":"{id}","cleanExit":true,"webProcessTermination":"none"}}"#
            )
            .into_bytes(),
            // Only the closed termination enum is accepted.
            format!(
                r#"{{"version":1,"launchId":"{id}","cleanExit":true,"webProcessTermination":"https://target.example/"}}"#
            )
            .into_bytes(),
            format!(r#"{{"version":1,"launchId":"{id}","cleanExit":true}}"#).into_bytes(),
        ] {
            fs::write(&receipt, bytes).unwrap();
            let diagnostics = LifecycleDiagnostics::start(Some(dir.clone()));
            assert_eq!(
                previous(&diagnostics),
                (PreviousExit::Unknown, WebProcessTermination::Unknown)
            );
        }
        // Startup still records this launch, and recovery is automatic.
        let next = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(next.snapshot(0).previous_exit, PreviousExit::Unclean);
        fs::remove_dir_all(&dir).unwrap();

        // An unusable app-data location degrades to unknown.
        let file = scratch();
        fs::write(&file, b"existing user file").unwrap();
        let diagnostics = LifecycleDiagnostics::start(Some(file.join("nested")));
        assert_eq!(diagnostics.snapshot(0).previous_exit, PreviousExit::Unknown);
        diagnostics.record_web_process_termination(WebProcessTermination::Crashed);
        diagnostics.record_clean_exit();
        assert_eq!(fs::read(&file).unwrap(), b"existing user file");
        fs::remove_file(file).unwrap();
        let unavailable = LifecycleDiagnostics::start(None);
        assert_eq!(
            previous(&unavailable),
            (PreviousExit::Unknown, WebProcessTermination::Unknown)
        );
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_diagnostics_never_follow_a_linked_receipt() {
        let dir = scratch();
        fs::create_dir_all(&dir).unwrap();
        let target = scratch();
        let clean = format!(
            r#"{{"version":1,"launchId":"{}","cleanExit":true,"webProcessTermination":"crashed"}}"#,
            "a".repeat(32)
        );
        fs::write(&target, &clean).unwrap();
        std::os::unix::fs::symlink(&target, dir.join(RECEIPT_FILE)).unwrap();
        let diagnostics = LifecycleDiagnostics::start(Some(dir.clone()));
        assert_eq!(
            previous(&diagnostics),
            (PreviousExit::Unknown, WebProcessTermination::Unknown)
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), clean);
        fs::remove_dir_all(dir).unwrap();
        fs::remove_file(target).unwrap();
    }

    #[test]
    fn lifecycle_diagnostics_snapshot_has_only_fixed_fields() {
        let diagnostics = LifecycleDiagnostics::start(None);
        diagnostics.record_web_process_termination(WebProcessTermination::MemoryLimit);
        let value = serde_json::to_value(diagnostics.snapshot(3)).unwrap();
        let mut fields: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "launchId",
                "pageGeneration",
                "previousExit",
                "previousWebProcessTermination",
                "webProcessTermination"
            ]
        );
        assert_eq!(value["pageGeneration"], 3);
        assert_eq!(value["previousExit"], "unknown");
        assert_eq!(value["previousWebProcessTermination"], "unknown");
        assert_eq!(value["webProcessTermination"], "memory_limit");
    }
}
