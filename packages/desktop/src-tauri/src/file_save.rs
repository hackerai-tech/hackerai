use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Publish a complete file without truncating the destination on write failure.
pub(crate) fn save_text(path: &Path, content: &str) -> io::Result<()> {
    save_with_writer(path, |file| file.write_all(content.as_bytes()))
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
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = write(&mut file).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
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
}
