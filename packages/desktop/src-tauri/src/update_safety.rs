//! Installation is exclusive with native commands, terminals and file mutations.
//! The installer may exit the process on Windows, so all consent and durable
//! bookkeeping must happen before handing it the verified download.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path, sync::Mutex};

#[derive(Default)]
struct Activity {
    operations: usize,
    installing: bool,
}
#[derive(Default)]
pub(crate) struct UpdateGate(Mutex<Activity>);
pub(crate) static UPDATE_GATE: UpdateGate = UpdateGate(Mutex::new(Activity {
    operations: 0,
    installing: false,
}));
pub(crate) struct Operation<'a>(&'a UpdateGate);
pub(crate) struct Installation<'a>(&'a UpdateGate);
impl UpdateGate {
    pub(crate) fn operation(&self) -> Result<Operation<'_>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Desktop update state unavailable")?;
        if state.installing {
            return Err("Desktop is installing an update. Reopen the app before retrying.".into());
        }
        state.operations += 1;
        Ok(Operation(self))
    }
    pub(crate) fn install(&self) -> Result<Installation<'_>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Desktop update state unavailable")?;
        if state.installing {
            return Err("An update is already being installed.".into());
        }
        if state.operations != 0 {
            return Err("Finish running commands, close terminal sessions, and let file operations complete before installing. Your current work has not been stopped.".into());
        }
        state.installing = true;
        Ok(Installation(self))
    }
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        let mut state = self.0 .0.lock().unwrap_or_else(|e| e.into_inner());
        state.operations -= 1;
    }
}
impl Drop for Installation<'_> {
    fn drop(&mut self) {
        self.0
             .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .installing = false;
    }
}

/// The Windows installer can terminate this process before returning. Keep
/// approval, exclusive admission and durable restart verification before it.
pub(crate) fn install_after_approval(
    gate: &UpdateGate,
    directory: &Path,
    from: &str,
    target: &str,
    approved: bool,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !approved {
        return Ok(());
    }
    let _installation = gate.install()?;
    Receipt::save(directory, from, target)?;
    // Retain the receipt even on error: installation may have partially applied.
    install()
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Receipt {
    pub from: String,
    pub target: String,
}
#[derive(Debug, PartialEq)]
pub(crate) enum RestartResult {
    Applied,
    NotApplied,
    Superseded,
}
const RECEIPT_FILE: &str = "pending-desktop-update.json";
fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.starts_with(|c: char| c.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}
impl Receipt {
    pub(crate) fn save(directory: &Path, from: &str, target: &str) -> Result<(), String> {
        if !valid_version(from) || !valid_version(target) || from == target {
            return Err("Invalid update version".into());
        }
        fs::create_dir_all(directory).map_err(|_| "Could not prepare update verification")?;
        let temporary = directory.join(format!(".update-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(&Self {
                from: from.into(),
                target: target.into(),
            })?)?;
            file.sync_all()?;
            fs::rename(&temporary, directory.join(RECEIPT_FILE))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|_| "Could not save update verification. The update was not started.".into())
    }
    pub(crate) fn take(
        directory: &Path,
        current: &str,
    ) -> Result<Option<(Self, RestartResult)>, String> {
        let path = directory.join(RECEIPT_FILE);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Could not read update verification".into()),
        };
        // Never read an arbitrary linked file or unbounded corrupted receipt.
        let receipt = if metadata.is_file() && metadata.len() <= 1024 {
            fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Self>(&b).ok())
        } else {
            None
        };
        fs::remove_file(&path).map_err(|_| "Could not clear update verification")?;
        let receipt = receipt
            .filter(|r| valid_version(&r.from) && valid_version(&r.target) && r.from != r.target)
            .ok_or("Invalid update verification")?;
        let outcome = if current == receipt.target {
            RestartResult::Applied
        } else if current == receipt.from {
            RestartResult::NotApplied
        } else {
            RestartResult::Superseded
        };
        Ok(Some((receipt, outcome)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installer_handoff_requires_approval_idle_work_and_durable_receipt() {
        let dir = std::env::temp_dir().join(format!("update-handoff-{}", uuid::Uuid::new_v4()));
        let gate = UpdateGate::default();
        install_after_approval(&gate, &dir, "1.0.0", "1.0.1", false, || {
            panic!("cancel must not install")
        })
        .unwrap();
        assert!(!dir.exists());
        let work = gate.operation().unwrap();
        assert!(
            install_after_approval(&gate, &dir, "1.0.0", "1.0.1", true, || panic!(
                "busy must not install"
            ))
            .is_err()
        );
        assert!(!dir.exists());
        drop(work);
        fs::write(&dir, b"existing user file").unwrap();
        assert!(
            install_after_approval(&gate, &dir, "1.0.0", "1.0.1", true, || panic!(
                "failed receipt must not install"
            ))
            .is_err()
        );
        assert_eq!(fs::read(&dir).unwrap(), b"existing user file");
        fs::remove_file(&dir).unwrap();
        assert!(
            install_after_approval(&gate, &dir, "1.0.0", "1.0.1", true, || {
                let saved: Receipt =
                    serde_json::from_slice(&fs::read(dir.join(RECEIPT_FILE)).unwrap()).unwrap();
                assert_eq!(
                    saved,
                    Receipt {
                        from: "1.0.0".into(),
                        target: "1.0.1".into()
                    }
                );
                assert!(gate.operation().is_err());
                Err("simulated installer failure".into())
            })
            .is_err()
        );
        assert!(gate.operation().is_ok());
        assert_eq!(
            Receipt::take(&dir, "1.0.0").unwrap().unwrap().1,
            RestartResult::NotApplied
        );
        install_after_approval(&gate, &dir, "1.0.0", "1.0.1", true, || Ok(())).unwrap();
        assert_eq!(
            Receipt::take(&dir, "1.0.1").unwrap().unwrap().1,
            RestartResult::Applied
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn active_work_prevents_installation_without_stopping_it() {
        let gate = UpdateGate::default();
        let command = gate.operation().unwrap();
        let file_write = gate.operation().unwrap();
        assert!(gate.install().is_err());
        drop(command);
        assert!(gate.install().is_err());
        drop(file_write);
        assert!(gate.install().is_ok());
    }
    #[test]
    fn install_blocks_new_work_and_failure_reopens_admission() {
        let gate = UpdateGate::default();
        let installing = gate.install().unwrap();
        assert!(gate.operation().is_err());
        assert!(gate.install().is_err());
        drop(installing);
        assert!(gate.operation().is_ok());
    }
    #[test]
    fn receipt_proves_restart_version_and_is_consumed_once() {
        let dir = std::env::temp_dir().join(format!("update-receipt-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let sentinel = dir.join("user-file");
        fs::write(&sentinel, b"unchanged").unwrap();
        for (current, expected) in [
            ("1.0.1", RestartResult::Applied),
            ("1.0.0", RestartResult::NotApplied),
            ("1.0.2", RestartResult::Superseded),
        ] {
            Receipt::save(&dir, "1.0.0", "1.0.1").unwrap();
            assert_eq!(Receipt::take(&dir, current).unwrap().unwrap().1, expected);
            assert!(Receipt::take(&dir, current).unwrap().is_none());
            assert_eq!(fs::read(&sentinel).unwrap(), b"unchanged");
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_receipt_does_not_permanently_block_retry() {
        let dir = std::env::temp_dir().join(format!("update-receipt-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        for bytes in [b"partial json".to_vec(), vec![b'x'; 2048]] {
            fs::write(dir.join(RECEIPT_FILE), bytes).unwrap();
            assert!(Receipt::take(&dir, "1.0.0").is_err());
            Receipt::save(&dir, "1.0.0", "1.0.1").unwrap();
            assert!(Receipt::take(&dir, "1.0.1").is_ok());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn bookkeeping_failure_prevents_handoff_and_leaves_files_untouched() {
        let file = std::env::temp_dir().join(format!("update-receipt-{}", uuid::Uuid::new_v4()));
        fs::write(&file, b"existing content").unwrap();
        assert!(Receipt::save(&file, "1.0.0", "1.0.1").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"existing content");
        fs::remove_file(file).unwrap();
    }
}
