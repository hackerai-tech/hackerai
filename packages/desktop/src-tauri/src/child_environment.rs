use std::ffi::OsString;

/// Override only the AppImage-injected library search paths for host children.
/// The outer None leaves inheritance unchanged; the inner None removes the variable.
pub fn appimage_library_path_override() -> Option<Option<OsString>> {
    #[cfg(target_os = "linux")]
    {
        filter_appimage_libraries(
            std::env::var_os("APPIMAGE").as_deref(),
            std::env::var_os("APPDIR").as_deref(),
            std::env::var_os("LD_LIBRARY_PATH").as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn filter_appimage_libraries(
    appimage: Option<&std::ffi::OsStr>,
    appdir: Option<&std::ffi::OsStr>,
    libraries: Option<&std::ffi::OsStr>,
) -> Option<Option<OsString>> {
    use std::path::{Component, Path};

    // AppImage exports both values. Do not change ordinary deb/dev launches, or
    // interpret a malformed/root APPDIR as ownership of every system library.
    let image = Path::new(appimage?);
    let root = Path::new(appdir?);
    if !image.is_absolute()
        || !root.is_absolute()
        || root.parent().is_none()
        || root.components().any(|c| matches!(c, Component::ParentDir))
    {
        return None;
    }
    let original: Vec<_> = std::env::split_paths(libraries?).collect();
    let retained: Vec<_> = original
        .iter()
        .filter(|path| {
            // Preserve ambiguous entries rather than stripping a host path that
            // escapes the bundle. Actual launcher entries contain no parent hops.
            !path.starts_with(root) || path.components().any(|c| matches!(c, Component::ParentDir))
        })
        .collect();
    if retained.len() == original.len() {
        return None;
    }
    if retained.iter().all(|path| path.as_os_str().is_empty()) {
        return Some(None);
    }
    // split_paths/join_paths preserve non-UTF8 host paths and existing empty
    // entries. Never create an empty search path when only bundle paths existed.
    std::env::join_paths(retained).ok().map(Some)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn filtered(value: &str) -> Option<Option<OsString>> {
        filter_appimage_libraries(
            Some(OsStr::new("/home/test/HackerAI.AppImage")),
            Some(OsStr::new("/tmp/.mount_HackerAI")),
            Some(OsStr::new(value)),
        )
    }

    #[test]
    fn removes_only_bundle_paths_and_preserves_host_order() {
        assert_eq!(
            filtered("/opt/custom:/tmp/.mount_HackerAI/usr/lib/:relative:/tmp/.mount_HackerAI/lib64:/opt/other"),
            Some(Some(OsString::from("/opt/custom:relative:/opt/other")))
        );
        assert_eq!(filtered("/tmp/.mount_HackerAI/lib"), Some(None));
        assert_eq!(filtered("/tmp/.mount_HackerAI/lib:"), Some(None));
        assert_eq!(filtered(":/tmp/.mount_HackerAI/lib::"), Some(None));
    }

    #[test]
    fn preserves_prefix_lookalikes_parent_hops_and_existing_empty_entries() {
        assert_eq!(filtered("/tmp/.mount_HackerAI-other/lib"), None);
        assert_eq!(filtered("/tmp/.mount_HackerAI/../host/lib"), None);
        assert_eq!(
            filtered("/tmp/.mount_HackerAI/lib::/opt/host"),
            Some(Some(OsString::from(":/opt/host")))
        );
        assert_eq!(filtered(""), None);
    }

    #[test]
    fn ordinary_or_malformed_launches_leave_inheritance_unchanged() {
        for (image, root) in [
            (None, Some("/tmp/.mount_HackerAI")),
            (Some("/home/test/HackerAI.AppImage"), None),
            (Some("relative.AppImage"), Some("/tmp/.mount_HackerAI")),
            (Some("/home/test/HackerAI.AppImage"), Some("/")),
            (Some("/home/test/HackerAI.AppImage"), Some("relative")),
            (Some("/home/test/HackerAI.AppImage"), Some("/tmp/../")),
        ] {
            assert_eq!(
                filter_appimage_libraries(
                    image.map(OsStr::new),
                    root.map(OsStr::new),
                    Some(OsStr::new("/tmp/.mount_HackerAI/lib"))
                ),
                None
            );
        }
        assert_eq!(
            filter_appimage_libraries(
                Some(OsStr::new("/app/image")),
                Some(OsStr::new("/app/root")),
                None
            ),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn preserves_non_utf8_host_library_paths() {
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(
            filter_appimage_libraries(
                Some(OsStr::new("/app/image")),
                Some(OsStr::new("/app/root")),
                Some(OsStr::from_bytes(b"/app/root/lib:/host/\xff"))
            ),
            Some(Some(OsStr::from_bytes(b"/host/\xff").to_os_string()))
        );
    }
}
