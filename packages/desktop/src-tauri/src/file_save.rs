use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Publish a complete file without truncating the destination on write failure.
#[cfg(test)]
pub(crate) fn save_text(path: &Path, content: &str) -> io::Result<()> {
    save_bytes(path, content.as_bytes())
}

pub(crate) fn save_bytes(path: &Path, content: &[u8]) -> io::Result<()> {
    save_with_writer(path, |file| file.write_all(content))
}

fn save_with_writer(
    path: &Path,
    write: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "Destination has no directory")
    })?;
    // Keep staging on the same filesystem as the selected destination.
    let temporary = parent.join(format!(".hackerai-save-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(permissions::PRIVATE);
    }
    let mut file = options.open(&temporary)?;
    // Widen only complete content, using the destination as it is just before publication.
    let result = write(&mut file)
        .and_then(|()| file.sync_all())
        .and_then(|()| keep_destination_permissions(&file, &temporary, path));
    drop(file);
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn keep_destination_permissions(
    staging: &File,
    temporary: &Path,
    destination: &Path,
) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "linux")]
    if !permissions::supports_mode_copy(staging) {
        return Ok(());
    }
    match permissions::replacement_mode(destination, temporary, &staging.metadata()?) {
        Some(mode) if mode != permissions::PRIVATE => {
            staging.set_permissions(fs::Permissions::from_mode(mode))
        }
        _ => Ok(()),
    }
}

#[cfg(not(unix))]
fn keep_destination_permissions(_: &File, _: &Path, _: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
mod permissions {
    use std::fs::{self, Metadata};
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    /// New saves, and replacements whose old permissions cannot be carried over safely.
    pub(super) const PRIVATE: u32 = 0o600;

    #[cfg(target_os = "linux")]
    pub(super) fn supports_mode_copy(staging: &fs::File) -> bool {
        use std::os::fd::AsRawFd;
        // From Linux's uapi/linux/magic.h. These mounts can have native ACLs
        // even when the POSIX and NFSv4 ACL probes report unsupported.
        const SMB_SUPER_MAGIC: u32 = 0x517B;
        const CIFS_SUPER_MAGIC: u32 = 0xFF53_4D42;
        const SMB2_SUPER_MAGIC: u32 = 0xFE53_4D42;
        let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: the file stays open and the buffer is writable and correctly aligned.
        if unsafe { libc::fstatfs(staging.as_raw_fd(), stats.as_mut_ptr()) } != 0 {
            return false;
        }
        // SAFETY: fstatfs succeeded and initialized the buffer.
        let kind = unsafe { stats.assume_init() }.f_type as u32;
        !matches!(kind, SMB_SUPER_MAGIC | CIFS_SUPER_MAGIC | SMB2_SUPER_MAGIC)
    }

    /// The old rwx bits when the replacement can take them without granting
    /// anything the destination did not: a regular file (never a symlink's
    /// target) with the replacement's owner and group and no access ACL that
    /// the new inode would lose. Setuid, setgid and sticky bits are dropped.
    pub(super) fn replacement_mode(
        destination: &Path,
        temporary: &Path,
        staging: &Metadata,
    ) -> Option<u32> {
        let before = fs::symlink_metadata(destination).ok()?;
        if !before.file_type().is_file()
            || before.uid() != staging.uid()
            || before.gid() != staging.gid()
            || !lacks_access_acl(destination)
            // A chmod could activate inherited ACL entries masked at creation.
            || !lacks_access_acl(temporary)
        {
            return None;
        }
        // A replaced file or any chmod, chown or ACL change updates these.
        let after = fs::symlink_metadata(destination).ok()?;
        let identity = |metadata: &Metadata| {
            (
                metadata.dev(),
                metadata.ino(),
                metadata.mode(),
                metadata.uid(),
                metadata.gid(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        };
        (identity(&before) == identity(&after)).then_some(before.mode() & 0o777)
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn path_string(path: &Path) -> Option<std::ffi::CString> {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::CString::new(path.as_os_str().as_bytes()).ok()
    }

    /// True only when the filesystem reports no ACL; unknown counts as present.
    #[cfg(target_os = "linux")]
    fn lacks_access_acl(path: &Path) -> bool {
        let Some(path) = path_string(path) else {
            return false;
        };
        [c"system.posix_acl_access", c"system.nfs4_acl"]
            .iter()
            .all(|name| {
                // SAFETY: both strings are NUL-terminated; a zero size only queries.
                let size = unsafe {
                    libc::lgetxattr(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0)
                };
                size < 0
                    && matches!(
                        std::io::Error::last_os_error().raw_os_error(),
                        Some(libc::ENODATA | libc::EOPNOTSUPP)
                    )
            })
    }

    /// True only when the filesystem reports no ACL; unknown counts as present.
    #[cfg(target_os = "macos")]
    fn lacks_access_acl(path: &Path) -> bool {
        use std::ffi::{c_char, c_int, c_void};
        extern "C" {
            fn acl_get_link_np(path: *const c_char, kind: c_int) -> *mut c_void;
            fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
            fn acl_free(object: *mut c_void) -> c_int;
        }
        const ACL_TYPE_EXTENDED: c_int = 0x100;
        const ACL_FIRST_ENTRY: c_int = 0;
        let Some(path) = path_string(path) else {
            return false;
        };
        // SAFETY: the path is NUL-terminated and does not follow a final symlink.
        let acl = unsafe { acl_get_link_np(path.as_ptr(), ACL_TYPE_EXTENDED) };
        if acl.is_null() {
            return matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ENOENT | libc::ENOTSUP | libc::EOPNOTSUPP)
            );
        }
        let mut entry = std::ptr::null_mut();
        // SAFETY: `acl` is a live ACL returned above and is freed exactly once.
        let empty = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL);
        unsafe { acl_free(acl) };
        empty
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn lacks_access_acl(_: &Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hackerai-save-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn entries(&self) -> usize {
            fs::read_dir(&self.0).unwrap().count()
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn binary_report_preserves_every_byte() {
        let dir = Directory::new();
        let path = dir.0.join("report.pdf");
        let content = b"%PDF-1.7\n\x00\xff\xfe\x80\n%%EOF";
        save_bytes(&path, content).unwrap();
        assert_eq!(fs::read(&path).unwrap(), content);
    }

    #[test]
    fn creates_and_replaces_exact_content() {
        let directory = Directory::new();
        let path = directory.0.join("report.md");
        save_text(&path, "Original").unwrap();
        save_text(&path, "```python\nprint(2)\n```\nUpdated remediation ✓").unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "```python\nprint(2)\n```\nUpdated remediation ✓"
        );
        assert_eq!(directory.entries(), 1);
    }

    #[test]
    fn partial_write_failure_preserves_existing_file() {
        let directory = Directory::new();
        let path = directory.0.join("report.md");
        fs::write(&path, "Saved report").unwrap();
        let result = save_with_writer(&path, |file| {
            file.write_all(b"Partial replacement")?;
            Err(io::Error::new(
                io::ErrorKind::Other,
                "Injected write failure",
            ))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "Saved report");
        assert_eq!(directory.entries(), 1);
    }

    #[test]
    fn failed_new_write_leaves_no_destination_or_staging_file() {
        let directory = Directory::new();
        let path = directory.0.join("report.md");
        assert!(save_with_writer(&path, |_| Err(io::Error::new(
            io::ErrorKind::Other,
            "Failed"
        )))
        .is_err());
        assert!(!path.exists());
        assert_eq!(directory.entries(), 0);
    }

    #[test]
    fn failed_replace_preserves_destination_and_cleans_staging() {
        let directory = Directory::new();
        let path = directory.0.join("existing-directory");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep.md"), "Keep this").unwrap();
        assert!(save_text(&path, "Replacement").is_err());
        assert_eq!(
            fs::read_to_string(path.join("keep.md")).unwrap(),
            "Keep this"
        );
        assert_eq!(directory.entries(), 1);
    }

    #[cfg(unix)]
    mod unix_permissions {
        use super::*;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        fn existing(directory: &Directory, mode: u32) -> PathBuf {
            let path = directory.0.join("report.md");
            fs::write(&path, "Saved report").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            path
        }

        fn mode(path: &Path) -> u32 {
            fs::symlink_metadata(path).unwrap().mode() & 0o7777
        }

        #[test]
        fn new_file_is_private() {
            let directory = Directory::new();
            let path = directory.0.join("report.md");
            save_text(&path, "Report").unwrap();
            assert_eq!(mode(&path), 0o600);
        }

        #[test]
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        fn overwrite_keeps_ordinary_permissions() {
            for original in [0o644, 0o640, 0o600] {
                let directory = Directory::new();
                let path = existing(&directory, original);
                save_text(&path, "Replacement").unwrap();
                assert_eq!(mode(&path), original, "{original:o}");
                assert_eq!(fs::read_to_string(&path).unwrap(), "Replacement");
                assert_eq!(directory.entries(), 1);
            }
        }

        #[test]
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        fn overwrite_drops_setuid() {
            let directory = Directory::new();
            let path = existing(&directory, 0o4755);
            assert_eq!(mode(&path), 0o4755);
            save_text(&path, "Replacement").unwrap();
            assert_eq!(mode(&path), 0o755);
        }

        #[test]
        fn symlink_is_replaced_without_touching_or_copying_target() {
            let directory = Directory::new();
            let target = directory.0.join("target.md");
            fs::write(&target, "Target").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
            let link = directory.0.join("link.md");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            save_text(&link, "Replacement").unwrap();
            assert!(fs::symlink_metadata(&link).unwrap().file_type().is_file());
            assert_eq!(mode(&link), 0o600);
            assert_eq!(fs::read_to_string(&link).unwrap(), "Replacement");
            assert_eq!(fs::read_to_string(&target).unwrap(), "Target");
            assert_eq!(mode(&target), 0o644);
        }

        #[test]
        fn different_group_replacement_stays_private() {
            let directory = Directory::new();
            let path = existing(&directory, 0o644);
            let current = fs::metadata(&path).unwrap().gid();
            let Some(group) = other_group(current) else {
                eprintln!("skipped: no second group available to this user");
                return;
            };
            std::os::unix::fs::chown(&path, None, Some(group)).unwrap();
            save_text(&path, "Replacement").unwrap();
            assert_eq!(mode(&path), 0o600);
        }

        fn other_group(current: u32) -> Option<u32> {
            // SAFETY: querying the effective user and supplementary groups only.
            if unsafe { libc::geteuid() } == 0 {
                return Some(if current == 1 { 2 } else { 1 });
            }
            let mut groups = vec![0; 256];
            // SAFETY: the buffer holds the requested number of group ids.
            let count =
                unsafe { libc::getgroups(groups.len() as libc::c_int, groups.as_mut_ptr()) };
            groups.truncate(count.max(0) as usize);
            groups.into_iter().find(|&group| group != current)
        }

        #[test]
        fn access_acl_keeps_replacement_private() {
            let directory = Directory::new();
            let path = existing(&directory, 0o644);
            if !add_access_acl(&path) {
                eprintln!("skipped: filesystem does not support access ACLs");
                return;
            }
            save_text(&path, "Replacement").unwrap();
            assert_eq!(mode(&path), 0o600);
        }

        #[cfg(target_os = "macos")]
        fn add_access_acl(path: &Path) -> bool {
            std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone allow read"])
                .arg(path)
                .status()
                .unwrap()
                .success()
        }

        #[cfg(target_os = "linux")]
        fn add_access_acl(path: &Path) -> bool {
            set_posix_acl(path, c"system.posix_acl_access")
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn inherited_acl_keeps_replacement_private() {
            let directory = Directory::new();
            let path = existing(&directory, 0o644);
            // The original predates the directory ACL and has ordinary mode bits.
            if !set_posix_acl(&directory.0, c"system.posix_acl_default") {
                eprintln!("skipped: filesystem does not support default ACLs");
                return;
            }
            save_text(&path, "Replacement").unwrap();
            assert_eq!(mode(&path), 0o600);
        }

        #[cfg(target_os = "linux")]
        fn set_posix_acl(path: &Path, attribute: &std::ffi::CStr) -> bool {
            use std::os::unix::ffi::OsStrExt;
            // POSIX ACL xattr v2: owner rwx, named user r, group r, mask r, other r.
            let named_uid = unsafe { libc::geteuid() } ^ 1;
            let mut value = 2u32.to_le_bytes().to_vec();
            for (tag, permission, id) in [
                (0x01u16, 7u16, u32::MAX),
                (0x02, 4, named_uid),
                (0x04, 4, u32::MAX),
                (0x10, 4, u32::MAX),
                (0x20, 4, u32::MAX),
            ] {
                value.extend(tag.to_le_bytes());
                value.extend(permission.to_le_bytes());
                value.extend(id.to_le_bytes());
            }
            let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            // SAFETY: NUL-terminated strings and a value buffer of the passed length.
            let result = unsafe {
                libc::setxattr(
                    path.as_ptr(),
                    attribute.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            };
            if result == 0 {
                return true;
            }
            let error = io::Error::last_os_error();
            assert_eq!(error.raw_os_error(), Some(libc::EOPNOTSUPP), "{error}");
            false
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        fn add_access_acl(_: &Path) -> bool {
            false
        }

        #[test]
        fn permissions_follow_destination_at_publication() {
            let directory = Directory::new();
            let path = existing(&directory, 0o644);
            save_with_writer(&path, |file| {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
                file.write_all(b"Replacement")
            })
            .unwrap();
            assert_eq!(mode(&path), 0o600);
        }
    }
}
