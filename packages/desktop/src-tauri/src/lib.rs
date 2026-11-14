mod authorization_send_diagnostics;
mod platform;
mod update_safety;
#[cfg(test)]
mod update_safety_tests;
mod child_environment;
mod command_stdin;
mod environment_identity;
mod file_save;
mod pty;
#[cfg(test)]
mod updater_tests;
#[cfg(test)]
mod file_acl_tests;

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
#[cfg(any(debug_assertions, test))]
use tokio::io::AsyncWriteExt;

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60); // 24 hours
const DESKTOP_AUTH_STATE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING_DESKTOP_AUTH_STATES: usize = 16;

/// Port for the local dev auth callback server (0 = not started)
static DEV_AUTH_PORT: AtomicU16 = AtomicU16::new(0);

struct PendingDesktopAuthStates(std::sync::Mutex<HashMap<String, SystemTime>>);
struct SelectedLocalFiles(std::sync::Mutex<HashSet<PathBuf>>);

fn generate_desktop_auth_state() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn prune_expired_auth_states(states: &mut HashMap<String, SystemTime>, now: SystemTime) {
    states.retain(|_, expires_at| *expires_at > now);
    while states.len() >= MAX_PENDING_DESKTOP_AUTH_STATES {
        if let Some(oldest_key) = states
            .iter()
            .min_by_key(|(_, expires_at)| *expires_at)
            .map(|(state, _)| state.clone())
        {
            states.remove(&oldest_key);
        } else {
            break;
        }
    }
}

/// Get the dev auth callback port (0 if not running in dev mode)
#[tauri::command]
fn get_dev_auth_port() -> u16 {
    DEV_AUTH_PORT.load(Ordering::Relaxed)
}

#[tauri::command]
fn prepare_desktop_auth_state(
    pending_states: tauri::State<'_, PendingDesktopAuthStates>,
) -> Result<String, String> {
    let state = generate_desktop_auth_state();
    let now = SystemTime::now();
    let expires_at = now + DESKTOP_AUTH_STATE_TTL;
    let mut states = pending_states
        .0
        .lock()
        .map_err(|_| "desktop auth state lock poisoned".to_string())?;
    prune_expired_auth_states(&mut states, now);
    states.insert(state.clone(), expires_at);
    Ok(state)
}

/// Write only after the user selects a destination in the native save dialog.
/// No path supplied by the webview is accepted as a write destination.
#[tauri::command]
async fn save_file_with_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filename: String,
    content: String,
) -> Result<Option<String>, String> {
    save_report_with_dialog(app, window, filename, content.into_bytes()).await
}

#[tauri::command]
async fn save_binary_file_with_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filename: String,
    content_base64: String,
) -> Result<Option<String>, String> {
    use base64::Engine;
    if content_base64.len() > 24 * 1024 * 1024 {
        return Err("Report is too large".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|_| "Invalid report encoding".to_string())?;
    save_report_with_dialog(app, window, filename, bytes).await
}

#[tauri::command]
fn open_downloads_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}

async fn save_report_with_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    filename: String,
    content: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    tokio::task::spawn_blocking(move || {
        let _operation = update_safety::UPDATE_GATE.operation()?;
        let suggested_name = Path::new(&filename)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Invalid filename".to_string())?;
        let mut dialog = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(suggested_name);
        if let Ok(downloads) = app.path().download_dir() {
            dialog = dialog.set_directory(downloads);
        }
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        file_save::save_bytes(&path, &content).map_err(|error| error.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileMetadata {
    path: String,
    name: String,
    media_type: String,
    size: u64,
    last_modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileData {
    path: String,
    name: String,
    media_type: String,
    size: u64,
    last_modified: u64,
    base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTextFileData {
    path: String,
    name: String,
    media_type: String,
    size: u64,
    last_modified: u64,
    content: String,
}

#[tauri::command]
async fn pick_local_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_files()
            .unwrap_or_default();
        let mut paths = Vec::with_capacity(selected.len());
        let selected_files = app.state::<SelectedLocalFiles>();
        let mut grants = selected_files
            .0
            .lock()
            .map_err(|_| "Selected file lock poisoned".to_string())?;
        for selected_path in selected {
            let path = selected_path
                .into_path()
                .map_err(|error| error.to_string())?;
            let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
            if !canonical.is_file() {
                return Err("Selected path is not a file".to_string());
            }
            grants.insert(canonical);
            paths.push(path.to_string_lossy().into_owned());
        }
        Ok(paths)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn selected_file_path(grants: &SelectedLocalFiles, path: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|_| "File is no longer available")?;
    if !grants
        .0
        .lock()
        .map_err(|_| "Selected file lock poisoned".to_string())?
        .contains(&canonical)
    {
        return Err("Select this file in the Desktop picker first".to_string());
    }
    Ok(canonical)
}

fn guess_media_type(path: &std::path::Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "css" => "text/css",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[tauri::command]
fn get_local_file_metadata(
    path: String,
    grants: tauri::State<'_, SelectedLocalFiles>,
) -> Result<LocalFileMetadata, String> {
    let path_buf = selected_file_path(&grants, &path)?;
    local_file_metadata(&path, &path_buf)
}

fn local_file_metadata(path: &str, path_buf: &Path) -> Result<LocalFileMetadata, String> {
    let metadata = fs::metadata(&path_buf).map_err(|e| format!("Metadata error: {}", e))?;
    if !metadata.is_file() {
        return Err("Selected path is not a file".to_string());
    }

    let name = path_buf
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string();
    let last_modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    Ok(LocalFileMetadata {
        path: path.to_string(),
        name,
        media_type: guess_media_type(&path_buf),
        size: metadata.len(),
        last_modified,
    })
}

fn sanitize_generated_text_segment(value: &str, fallback: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('.');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn generated_text_attachment_path(
    app: &tauri::AppHandle,
    attachment_id: &str,
    file_name: &str,
    create_dir: bool,
) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("App data dir error: {}", e))?
        .join("generated-text-attachments")
        .join(sanitize_generated_text_segment(attachment_id, "attachment"));

    if create_dir {
        fs::create_dir_all(&base_dir).map_err(|e| format!("Directory error: {}", e))?;
    }

    Ok(base_dir.join(sanitize_generated_text_segment(
        file_name,
        "pasted_content.txt",
    )))
}

#[tauri::command]
fn write_generated_text_attachment(
    app: tauri::AppHandle,
    attachment_id: String,
    file_name: String,
    content: String,
) -> Result<LocalFileMetadata, String> {
    let _operation = update_safety::UPDATE_GATE.operation()?;
    let path = generated_text_attachment_path(&app, &attachment_id, &file_name, true)?;
    fs::write(&path, content.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
    local_file_metadata(&path.to_string_lossy(), &path)
}

#[tauri::command]
fn read_generated_text_attachment(
    app: tauri::AppHandle,
    attachment_id: String,
    file_name: String,
) -> Result<LocalTextFileData, String> {
    let path = generated_text_attachment_path(&app, &attachment_id, &file_name, false)?;
    let metadata = local_file_metadata(&path.to_string_lossy(), &path)?;
    let content = fs::read_to_string(&metadata.path).map_err(|e| format!("Read error: {}", e))?;

    Ok(LocalTextFileData {
        path: metadata.path,
        name: metadata.name,
        media_type: metadata.media_type,
        size: metadata.size,
        last_modified: metadata.last_modified,
        content,
    })
}

#[tauri::command]
fn remove_generated_text_attachment(
    app: tauri::AppHandle,
    attachment_id: String,
    file_name: String,
) -> Result<(), String> {
    let _operation = update_safety::UPDATE_GATE.operation()?;
    let path = generated_text_attachment_path(&app, &attachment_id, &file_name, false)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Remove error: {}", error)),
    }
}

#[tauri::command]
fn read_local_file(
    path: String,
    grants: tauri::State<'_, SelectedLocalFiles>,
) -> Result<LocalFileData, String> {
    read_local_file_data(path, None, &grants)
}

#[tauri::command(async)]
fn read_local_preview_file(
    path: String,
    grants: tauri::State<'_, SelectedLocalFiles>,
) -> Result<LocalFileData, String> {
    read_local_file_data(path, Some(10 * 1024 * 1024), &grants)
}

fn read_local_file_data(
    path: String,
    max_bytes: Option<u64>,
    grants: &SelectedLocalFiles,
) -> Result<LocalFileData, String> {
    use base64::Engine;
    use std::io::Read;

    let selected_path = selected_file_path(grants, &path)?;
    let metadata = local_file_metadata(&path, &selected_path)?;
    let bytes = if let Some(limit) = max_bytes {
        let limit = limit.min(10 * 1024 * 1024);
        if metadata.size > limit {
            return Err("File exceeds preview limit".into());
        }
        let file = fs::File::open(&selected_path).map_err(|_| "File is no longer available")?;
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read file")?;
        if bytes.len() as u64 > limit {
            return Err("File exceeds preview limit".into());
        }
        bytes
    } else {
        fs::read(&selected_path).map_err(|e| format!("Read error: {}", e))?
    };

    Ok(LocalFileData {
        path: metadata.path,
        name: metadata.name,
        media_type: metadata.media_type,
        size: metadata.size,
        last_modified: metadata.last_modified,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod local_preview_tests {
    use super::*;

    #[test]
    fn preview_requires_picker_grant_and_rejects_oversized_or_missing_files() {
        let path = std::env::temp_dir().join(format!(
            "hackerai-preview-{}-{}.txt",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, b"local preview").unwrap();
        let name = path.to_string_lossy().into_owned();
        let grants = SelectedLocalFiles(std::sync::Mutex::new(HashSet::new()));
        assert!(selected_file_path(&grants, &name).is_err());
        assert!(read_local_file_data(name.clone(), Some(1024), &grants).is_err());
        grants
            .0
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&path).unwrap());
        let result = read_local_file_data(name.clone(), Some(1024), &grants).unwrap();
        assert_eq!(result.base64, "bG9jYWwgcHJldmlldw==");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(10 * 1024 * 1024 + 1)
            .unwrap();
        assert!(
            matches!(read_local_file_data(name.clone(), Some(10 * 1024 * 1024), &grants), Err(e) if e == "File exceeds preview limit")
        );
        fs::remove_file(&path).unwrap();
        assert!(read_local_file_data(name, Some(1024), &grants).is_err());
    }
}

#[cfg(test)]
#[derive(Serialize)]
struct ExecResponse {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[cfg(test)]
async fn wait_with_output_or_kill_on_timeout(
    mut child: tokio::process::Child,
    timeout: Duration,
    timeout_ms: u64,
) -> Result<std::process::Output, String> {
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;
    let child_pid = child.id();
    let started_at = tokio::time::Instant::now();

    let stdout_task = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).await.map(|_| output)
    });
    let stderr_task = tokio::spawn(async move {
        let mut output = Vec::new();
        stderr.read_to_end(&mut output).await.map(|_| output)
    });

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            stdout_task.abort();
            stderr_task.abort();
            return Err(format!("Process error: {}", e));
        }
        Err(_) => {
            platform::graceful_kill(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(format!("Command timed out after {}ms", timeout_ms));
        }
    };

    let stdout_abort = stdout_task.abort_handle();
    let stderr_abort = stderr_task.abort_handle();
    let remaining = timeout
        .checked_sub(started_at.elapsed())
        .unwrap_or_else(|| Duration::from_millis(0));
    let drain_timeout = if remaining.is_zero() {
        Duration::from_millis(1)
    } else {
        remaining
    };

    let drain_result = tokio::time::timeout(drain_timeout, async {
        let stdout = match stdout_task.await {
            Ok(Ok(output)) => output,
            _ => Vec::new(),
        };
        let stderr = match stderr_task.await {
            Ok(Ok(output)) => output,
            _ => Vec::new(),
        };
        (stdout, stderr)
    })
    .await;

    let (stdout, stderr) = match drain_result {
        Ok(output) => output,
        Err(_) => {
            if let Some(pid) = child_pid {
                let _ = platform::cancel_process_tree(pid).await;
            }
            stdout_abort.abort();
            stderr_abort.abort();
            return Err(format!("Command timed out after {}ms", timeout_ms));
        }
    };

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

#[derive(Deserialize)]
struct FileReadRequest {
    path: String,
    range_start: Option<u64>,
    range_end: Option<i64>,
    max_full_bytes: Option<u64>,
    max_result_bytes: Option<usize>,
}

#[derive(Deserialize)]
struct FileWriteRequest {
    path: String,
    content: String,
    allowed_root: Option<String>,
    #[serde(default)]
    is_base64: bool,
}

#[derive(Deserialize)]
struct FileRemoveRequest {
    path: String,
}

#[derive(Deserialize)]
struct FileAppendRequest {
    path: String,
    content: String,
    allowed_root: Option<String>,
    #[serde(default)]
    is_base64: bool,
}

#[derive(Deserialize)]
struct FileListRequest {
    path: String,
}

#[derive(Deserialize)]
struct FileStatRequest {
    path: String,
}

async fn count_file_lines(path: &std::path::Path, file_size: u64) -> Result<u64, String> {
    if file_size == 0 {
        return Ok(0);
    }

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Open error: {}", e))?;
    let mut buf = [0u8; 64 * 1024];
    let mut lines = 0u64;
    let mut last_byte = 0u8;

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        lines += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
        last_byte = buf[n - 1];
    }

    if last_byte != b'\n' {
        lines += 1;
    }

    Ok(lines)
}

fn scoped_mutation_target(path: &Path, allowed_root: &str) -> Result<(Dir, PathBuf), String> {
    let root = Path::new(allowed_root);
    if !root.is_absolute() || !path.is_absolute() {
        return Err("Desktop project file mutations require absolute paths".to_string());
    }

    let relative_path = path.strip_prefix(root).map_err(|_| {
        format!(
            "Path is outside the allowed project folder: {}",
            path.display()
        )
    })?;
    if relative_path.as_os_str().is_empty()
        || relative_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "Path is outside the allowed project folder: {}",
            path.display()
        ));
    }

    let dir = Dir::open_ambient_dir(root, ambient_authority()).map_err(|error| {
        format!(
            "Allowed root error: could not open project folder '{}': {}",
            root.display(),
            error
        )
    })?;
    Ok((dir, relative_path.to_path_buf()))
}

fn open_scoped_mutation_file(
    path: &Path,
    allowed_root: &str,
    append: bool,
) -> Result<cap_std::fs::File, String> {
    let (dir, relative_path) = scoped_mutation_target(path, allowed_root)?;
    if let Some(parent) = relative_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        dir.create_dir_all(parent)
            .map_err(|error| format!("Mkdir error: {}", error))?;
    }

    let mut options = CapOpenOptions::new();
    options.create(true).follow(FollowSymlinks::No);
    if append {
        options.append(true);
    } else {
        options.write(true).truncate(true);
    }

    dir.open_with(&relative_path, &options)
        .map_err(|error| format!("Open error: {}", error))
}

fn open_unscoped_mutation_file(path: &Path, append: bool) -> Result<fs::File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Mkdir error: {}", error))?;
    }

    let mut options = fs::OpenOptions::new();
    options.create(true);
    if append {
        options.append(true);
    } else {
        options.write(true).truncate(true);
    }
    options
        .open(path)
        .map_err(|error| format!("Open error: {}", error))
}

fn write_desktop_file(
    path: &Path,
    allowed_root: Option<&str>,
    bytes: &[u8],
    append: bool,
) -> Result<(), String> {
    let _operation = update_safety::UPDATE_GATE.operation()?;
    let allowed_root = allowed_root.filter(|root| !root.trim().is_empty());
    if let Some(allowed_root) = allowed_root {
        let mut file = open_scoped_mutation_file(path, allowed_root, append)?;
        file.write_all(bytes)
            .map_err(|error| format!("Write error: {}", error))?;
        file.flush()
            .map_err(|error| format!("Flush error: {}", error))?;
    } else {
        let mut file = open_unscoped_mutation_file(path, append)?;
        file.write_all(bytes)
            .map_err(|error| format!("Write error: {}", error))?;
        file.flush()
            .map_err(|error| format!("Flush error: {}", error))?;
    }
    Ok(())
}

async fn handle_file_stat(body: &str) -> Result<String, String> {
    let req: FileStatRequest =
        serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = std::path::Path::new(&req.path);

    let payload = match tokio::fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => serde_json::json!({
            "kind": "file",
            "path": req.path,
            "sizeBytes": metadata.len(),
        }),
        Ok(_) => serde_json::json!({
            "kind": "not_file",
            "path": req.path,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({
            "kind": "missing",
            "path": req.path,
        }),
        Err(error) => return Err(format!("Metadata error: {}", error)),
    };

    serde_json::to_string(&payload).map_err(|e| e.to_string())
}

async fn handle_file_read(body: &str) -> Result<String, String> {
    let req: FileReadRequest =
        serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = std::path::Path::new(&req.path);
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("Metadata error: {}", e))?;
    if !metadata.is_file() {
        return Err("Selected path is not a file".to_string());
    }

    let range_start = req.range_start.unwrap_or(0);
    let range_end = req.range_end.unwrap_or(-1);
    let max_full_bytes = req.max_full_bytes.unwrap_or(1024 * 1024);
    let max_result_bytes = req.max_result_bytes.unwrap_or(1024 * 1024);
    let size_bytes = metadata.len();
    let should_count_lines = range_start == 0 || size_bytes <= max_full_bytes;
    let total_lines = if should_count_lines {
        count_file_lines(path, size_bytes).await?
    } else {
        0
    };

    if range_start == 0 && size_bytes > max_full_bytes {
        return serde_json::to_string(&serde_json::json!({
            "path": req.path,
            "sizeBytes": size_bytes,
            "totalLines": total_lines,
            "tooLarge": true,
        }))
        .map_err(|e| e.to_string());
    }

    if range_start > 0 && should_count_lines {
        if range_end != -1 && range_end < range_start as i64 {
            return Err(format!(
                "Invalid range: start_line ({}) cannot be greater than end_line ({}).",
                range_start, range_end
            ));
        }
        if range_start > total_lines {
            return Err(format!(
                "Invalid start_line: {}. File has {} lines (1-indexed).",
                range_start, total_lines
            ));
        }
        if range_end != -1 && range_end as u64 > total_lines {
            return Err(format!(
                "Invalid end_line: {}. File has {} lines (1-indexed).",
                range_end, total_lines
            ));
        }
    }

    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Open error: {}", e))?;
    let mut reader = tokio::io::BufReader::new(file);
    let mut line = Vec::<u8>::new();
    let mut line_no = 0u64;
    let mut selected = Vec::<u8>::new();
    let mut truncated = false;
    let start_line = if range_start > 0 { range_start } else { 1 };

    loop {
        line.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut line)
            .await
            .map_err(|e| format!("Read error: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        line_no += 1;

        if range_start > 0 && line_no < range_start {
            continue;
        }
        if range_start > 0 && range_end != -1 && line_no > range_end as u64 {
            break;
        }

        let remaining = max_result_bytes.saturating_sub(selected.len());
        if remaining == 0 {
            truncated = true;
            break;
        }
        if line.len() > remaining {
            selected.extend_from_slice(&line[..remaining]);
            truncated = true;
            break;
        }
        selected.extend_from_slice(&line);
    }

    let content = String::from_utf8_lossy(&selected).to_string();
    serde_json::to_string(&serde_json::json!({
        "path": req.path,
        "sizeBytes": size_bytes,
        "totalLines": total_lines,
        "content": content,
        "startLine": start_line,
        "truncated": truncated,
    }))
    .map_err(|e| e.to_string())
}

async fn handle_file_write(body: &str) -> Result<String, String> {
    let req: FileWriteRequest =
        serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = std::path::Path::new(&req.path);

    if req.is_base64 {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&req.content)
            .map_err(|e| format!("Base64 decode error: {}", e))?;
        write_desktop_file(path, req.allowed_root.as_deref(), &bytes, false)?;
    } else {
        write_desktop_file(
            path,
            req.allowed_root.as_deref(),
            req.content.as_bytes(),
            false,
        )?;
    }

    Ok(r#"{"ok":true}"#.to_string())
}

async fn handle_file_append(body: &str) -> Result<String, String> {
    let req: FileAppendRequest =
        serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = std::path::Path::new(&req.path);

    if req.is_base64 {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&req.content)
            .map_err(|e| format!("Base64 decode error: {}", e))?;
        write_desktop_file(path, req.allowed_root.as_deref(), &bytes, true)?;
    } else {
        write_desktop_file(
            path,
            req.allowed_root.as_deref(),
            req.content.as_bytes(),
            true,
        )?;
    }

    Ok(r#"{"ok":true}"#.to_string())
}

async fn handle_file_remove(body: &str) -> Result<String, String> {
    let _operation = update_safety::UPDATE_GATE.operation()?;
    let req: FileRemoveRequest =
        serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = std::path::Path::new(&req.path);

    if path.is_dir() {
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|e| format!("Remove error: {}", e))?;
    } else {
        tokio::fs::remove_file(path)
            .await
            .map_err(|e| format!("Remove error: {}", e))?;
    }

    Ok(r#"{"ok":true}"#.to_string())
}

async fn handle_file_list(body: &str) -> Result<String, String> {
    let req: FileListRequest =
        serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&req.path)
        .await
        .map_err(|e| format!("ReadDir error: {}", e))?;

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| format!("Entry error: {}", e))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(serde_json::json!({ "name": name }));
    }

    serde_json::to_string(&entries).map_err(|e| e.to_string())
}

// ── Tauri IPC Commands ────────────────────────────────────────────────

async fn dispatch_desktop_file_request(
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request_type = request
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Desktop file request is missing a type".to_string())?;
    let body = serde_json::to_string(&request)
        .map_err(|error| format!("Failed to serialize desktop file request: {}", error))?;

    let response = match request_type {
        "file_stat" => handle_file_stat(&body).await,
        "file_read" => handle_file_read(&body).await,
        "file_write" => handle_file_write(&body).await,
        "file_append" => handle_file_append(&body).await,
        "file_remove" => handle_file_remove(&body).await,
        "file_list" => handle_file_list(&body).await,
        _ => Err(format!(
            "Unsupported desktop file request type: {}",
            request_type
        )),
    }?;

    serde_json::from_str(&response)
        .map_err(|error| format!("Failed to parse desktop file response: {}", error))
}

#[cfg(test)]
#[tauri::command]
async fn desktop_file_request(request: serde_json::Value) -> Result<serde_json::Value, String> {
    dispatch_desktop_file_request(request).await
}

fn authorized_message_digest(message: &serde_json::Value) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let canonical =
        serde_json::to_vec(message).map_err(|_| "Invalid Desktop operation".to_string())?;
    Ok(format!("{:x}", Sha256::digest(&canonical)))
}

fn desktop_authorization_endpoint(loaded_url: &url::Url) -> Result<String, String> {
    let origin = loaded_url.origin().ascii_serialization();
    if !validate_origin(&origin) {
        return Err("Desktop origin is not allowed for native authorization".to_string());
    }
    Ok(format!("{origin}/api/desktop/authorized-operation"))
}

/// A finite class of the already validated loaded origin, never its hostname.
fn authorization_origin_class(
    loaded_url: &url::Url,
) -> authorization_send_diagnostics::OriginClass {
    use authorization_send_diagnostics::OriginClass;
    match (
        loaded_url.scheme(),
        loaded_url.host_str(),
        loaded_url.port(),
    ) {
        ("https", Some("hackerai.co"), None) => OriginClass::CanonicalProduction,
        (_, Some("localhost"), _) => OriginClass::Localhost,
        (_, Some(_), _) => OriginClass::OtherAllowed,
        _ => OriginClass::Unknown,
    }
}

/// Parse an optional frontend channel ID. Missing or malformed values only
/// disable diagnostics; they never reject the command.
fn authorization_diagnostic_channel_id(
    value: Option<serde_json::Value>,
) -> Option<tauri::ipc::JavaScriptChannelId> {
    serde_json::from_value(value?).ok()
}

async fn redeem_authorized_message<R: tauri::Runtime>(
    authorization_id: &str,
    message: serde_json::Value,
    window: &tauri::WebviewWindow<R>,
) -> Result<serde_json::Value, String> {
    redeem_authorized_message_observed(
        authorization_id,
        message,
        window,
        None::<
            fn(
                authorization_send_diagnostics::SendFailureReceipt,
                authorization_send_diagnostics::SendFailureCause,
            ),
        >,
    )
    .await
}

async fn redeem_authorized_message_observed<R: tauri::Runtime, F>(
    authorization_id: &str,
    mut message: serde_json::Value,
    window: &tauri::WebviewWindow<R>,
    send_failure_observer: Option<F>,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(
        authorization_send_diagnostics::SendFailureReceipt,
        authorization_send_diagnostics::SendFailureCause,
    ),
{
    if authorization_id.len() != 64
        || !authorization_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid Desktop operation authorization".to_string());
    }
    let fields = message
        .as_object_mut()
        .ok_or_else(|| "Invalid Desktop operation".to_string())?;
    fields.remove("authorizationId");
    fields.remove("operationChannel");
    let digest = authorized_message_digest(&message)?;

    let loaded_url = window
        .url()
        .map_err(|_| "Desktop origin is unavailable".to_string())?;
    let endpoint = desktop_authorization_endpoint(&loaded_url)?;
    let origin_class = authorization_origin_class(&loaded_url);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Desktop authorization client unavailable".to_string())?;
    let request = client
        .post(endpoint)
        .json(&serde_json::json!({ "id": authorization_id, "digest": digest }));
    let response =
        authorization_send_diagnostics::observed_send(request, origin_class, send_failure_observer)
            .await
            .map_err(|_| "Desktop operation authorization unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("Desktop operation was not authorized".to_string());
    }
    let approval: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Invalid Desktop authorization response".to_string())?;
    if approval.get("approved") != Some(&serde_json::Value::Bool(true)) {
        return Err("Desktop operation was not authorized".to_string());
    }
    Ok(message)
}

fn authorized_operation_type<'a>(
    message: &'a serde_json::Value,
    allowed: &[&str],
) -> Result<&'a str, String> {
    let kind = message
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Desktop operation type is missing".to_string())?;
    if !allowed.contains(&kind) {
        return Err("Desktop operation type is not allowed here".to_string());
    }
    Ok(kind)
}

#[tauri::command]
async fn authorized_desktop_file_request(
    window: tauri::WebviewWindow,
    authorization_id: String,
    message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let message = redeem_authorized_message(&authorization_id, message, &window).await?;
    let kind = authorized_operation_type(
        &message,
        &[
            "file_stat",
            "file_read",
            "file_write",
            "file_append",
            "file_remove",
            "file_list",
        ],
    )?;
    let path = message.get("path").cloned().ok_or("File path is missing")?;
    let request = match kind {
        "file_read" => {
            let range = message.get("range").and_then(serde_json::Value::as_array);
            serde_json::json!({
                "type": kind,
                "path": path,
                "range_start": range.and_then(|value| value.first()),
                "range_end": range.and_then(|value| value.get(1)),
                "max_full_bytes": message.get("maxFullBytes"),
                "max_result_bytes": message.get("maxResultBytes"),
            })
        }
        "file_write" | "file_append" => serde_json::json!({
            "type": kind,
            "path": path,
            "content": message.get("content"),
            "is_base64": message.get("isBase64").and_then(serde_json::Value::as_bool).unwrap_or(false),
            "allowed_root": message.get("allowedRoot"),
        }),
        _ => serde_json::json!({ "type": kind, "path": path }),
    };
    dispatch_desktop_file_request(request).await
}

#[tauri::command]
async fn probe_desktop_file_bridge() -> Result<serde_json::Value, String> {
    dispatch_desktop_file_request(serde_json::json!({ "type": "file_stat", "path": "." })).await
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum StreamEvent {
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    Exit {
        // Explicit rename needed: Tauri 2's Channel<T> does not apply
        // rename_all to fields inside internally-tagged enum variants.
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
    Error {
        message: String,
    },
}

#[derive(Default)]
struct StreamCommandRegistry {
    running: HashMap<String, u32>,
    // Keep cancellation until app exit, including IPCs that arrive before launch.
    canceled: HashSet<String>,
}

type StreamCommandState = std::sync::Arc<std::sync::Mutex<StreamCommandRegistry>>;

fn spawn_stream_command(
    state: &StreamCommandState,
    command_id: &str,
    cmd: &mut tokio::process::Command,
) -> Result<Option<tokio::process::Child>, String> {
    // Spawn and PID registration must be atomic with respect to cancellation.
    let mut commands = state
        .lock()
        .map_err(|_| "stream command state lock poisoned")?;
    if commands.canceled.contains(command_id) {
        return Ok(None);
    }
    if commands.running.contains_key(command_id) {
        return Err("Command is already running".to_string());
    }
    let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    if let Some(pid) = child.id() {
        commands.running.insert(command_id.to_string(), pid);
    }
    Ok(Some(child))
}

fn request_stream_command_cancel(
    state: &StreamCommandState,
    command_id: &str,
) -> Result<Option<u32>, String> {
    let mut commands = state
        .lock()
        .map_err(|_| "stream command state lock poisoned")?;
    commands.canceled.insert(command_id.to_string());
    Ok(commands.running.get(command_id).copied())
}
#[cfg(test)]
#[tauri::command]
async fn execute_command(
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResponse, String> {
    let _operation = update_safety::UPDATE_GATE.operation()?;
    let mut cmd = platform::build_command(&command, cwd.as_deref(), env.as_ref());
    let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30000));
    let timeout_ms = timeout_ms.unwrap_or(30000);
    let output = wait_with_output_or_kill_on_timeout(child, timeout, timeout_ms).await?;
    const MAX_OUTPUT: usize = 1024 * 1024;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout_str = if stdout.len() > MAX_OUTPUT {
        format!(
            "{}... [truncated, {} total bytes]",
            &stdout[..MAX_OUTPUT],
            stdout.len()
        )
    } else {
        stdout.to_string()
    };
    let stderr_str = if stderr.len() > MAX_OUTPUT {
        format!(
            "{}... [truncated, {} total bytes]",
            &stderr[..MAX_OUTPUT],
            stderr.len()
        )
    } else {
        stderr.to_string()
    };
    Ok(ExecResponse {
        stdout: stdout_str,
        stderr: stderr_str,
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
fn get_command_stdin_support() -> bool {
    true
}

#[derive(Serialize)]
struct DesktopOsInfo {
    platform: String,
    arch: String,
    release: String,
    hostname: String,
}

#[tauri::command]
fn get_desktop_os_info() -> DesktopOsInfo {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    DesktopOsInfo {
        platform: std::env::consts::OS.to_string(),
        arch: arch.to_string(),
        release: os_info::get().version().to_string(),
        hostname: gethostname::gethostname().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
async fn execute_stream_command(
    state: tauri::State<'_, StreamCommandState>,
    command_id: String,
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    stdin: Option<String>,
    stdin_encoding: Option<String>,
    timeout_ms: Option<u64>,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let _operation = update_safety::UPDATE_GATE.operation()?;
    let input = command_stdin::decode(stdin, stdin_encoding)?;
    let mut cmd = platform::build_command(&command, cwd.as_deref(), env.as_ref());
    if input.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let Some(mut child) = spawn_stream_command(&state, &command_id, &mut cmd)? else {
        let _ = on_event.send(StreamEvent::Exit { exit_code: 130 });
        return Ok(());
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30000));
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let child_stdin = child.stdin.take();
    let mut write_input = Box::pin(command_stdin::write(child_stdin, input));

    let result = tokio::time::timeout(timeout, async {
        let mut stdout_buf = [0u8; 4096];
        let mut stderr_buf = [0u8; 4096];
        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut input_done = false;

        loop {
            if stdout_done && stderr_done && input_done {
                break;
            }
            tokio::select! {
                result = &mut write_input, if !input_done => {
                    input_done = true;
                    result?;
                }
                result = stdout.read(&mut stdout_buf), if !stdout_done => {
                    match result {
                        Ok(0) => stdout_done = true,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&stdout_buf[..n]).to_string();
                            let _ = on_event.send(StreamEvent::Stdout { data });
                        }
                        Err(_) => stdout_done = true,
                    }
                }
                result = stderr.read(&mut stderr_buf), if !stderr_done => {
                    match result {
                        Ok(0) => stderr_done = true,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&stderr_buf[..n]).to_string();
                            let _ = on_event.send(StreamEvent::Stderr { data });
                        }
                        Err(_) => stderr_done = true,
                    }
                }
            }
        }
        child.wait().await
    })
    .await;

    match result {
        Ok(Ok(status)) => {
            let _ = on_event.send(StreamEvent::Exit {
                exit_code: status.code().unwrap_or(-1),
            });
        }
        Ok(Err(e)) => {
            platform::graceful_kill(&mut child).await;
            let _ = on_event.send(StreamEvent::Error {
                message: format!("Process error: {}", e),
            });
        }
        Err(_) => {
            platform::graceful_kill(&mut child).await;
            let _ = on_event.send(StreamEvent::Error {
                message: format!("Command timed out after {}ms", timeout_ms.unwrap_or(30000)),
            });
        }
    }
    if let Ok(mut commands) = state.lock() {
        commands.running.remove(&command_id);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedCommandMessage {
    command_id: String,
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    stdin: Option<String>,
    stdin_encoding: Option<String>,
    timeout: Option<u64>,
}

#[tauri::command]
async fn execute_authorized_stream_command<R: tauri::Runtime>(
    state: tauri::State<'_, StreamCommandState>,
    window: tauri::WebviewWindow<R>,
    authorization_id: String,
    message: serde_json::Value,
    on_event: tauri::ipc::Channel<StreamEvent>,
    // Separate from the signed message and output events; older frontends omit it.
    on_authorization_diagnostic: Option<serde_json::Value>,
    // The closed IO cause, on its own channel so the v1 receipt shape is frozen.
    on_authorization_cause_diagnostic: Option<serde_json::Value>,
) -> Result<(), String> {
    use authorization_send_diagnostics::{SendFailureCause, SendFailureReceipt};
    let webview = || AsRef::<tauri::Webview<R>>::as_ref(&window).clone();
    let receipt_channel = authorization_diagnostic_channel_id(on_authorization_diagnostic)
        .map(|id| id.channel_on::<R, SendFailureReceipt>(webview()));
    let cause_channel = authorization_diagnostic_channel_id(on_authorization_cause_diagnostic)
        .map(|id| id.channel_on::<R, SendFailureCause>(webview()));
    let send_failure_observer = (receipt_channel.is_some() || cause_channel.is_some()).then(|| {
        move |receipt: SendFailureReceipt, cause: SendFailureCause| {
            if let Some(channel) = &receipt_channel {
                let _ = channel.send(receipt);
            }
            if let Some(channel) = &cause_channel {
                let _ = channel.send(cause);
            }
        }
    });
    let message = redeem_authorized_message_observed(
        &authorization_id,
        message,
        &window,
        send_failure_observer,
    )
    .await?;
    authorized_operation_type(&message, &["command"])?;
    let command: AuthorizedCommandMessage =
        serde_json::from_value(message).map_err(|_| "Invalid authorized command".to_string())?;
    execute_stream_command(
        state,
        command.command_id,
        command.command,
        command.cwd,
        command.env,
        command.stdin,
        command.stdin_encoding,
        command.timeout,
        on_event,
    )
    .await
}

#[tauri::command]
async fn cancel_stream_command(
    state: tauri::State<'_, StreamCommandState>,
    command_id: String,
) -> Result<bool, String> {
    let pid = request_stream_command_cancel(&state, &command_id)?;

    if let Some(pid) = pid {
        Ok(platform::cancel_process_tree(pid).await)
    } else {
        // Either it already exited, or its future launch is now fenced. A
        // concurrent launch cannot pass the fence before registering its PID.
        Ok(true)
    }
}

/// Start a local HTTP server for dev mode auth callbacks.
/// This replaces deep links which don't work in `tauri dev` on macOS.
/// Only compiled in debug builds — matches the cfg-gated call site at the
/// bottom of `run()`. Without this gate, release builds error out with
/// `dead_code` under `actions-rust-lang/setup-rust-toolchain@v1`'s
/// `RUSTFLAGS=-D warnings`.
#[cfg(debug_assertions)]
async fn start_dev_auth_server(app_handle: tauri::AppHandle) {
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to start dev auth server: {}", e);
            return;
        }
    };

    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            log::error!("Failed to get dev auth server address: {}", e);
            return;
        }
    };
    DEV_AUTH_PORT.store(port, Ordering::Relaxed);
    log::info!(
        "Dev auth callback server listening on http://localhost:{}",
        port
    );

    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                log::warn!("Dev auth server accept error: {}", e);
                continue;
            }
        };

        let handle = app_handle.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let n = match stream.read(&mut buf).await {
                Ok(n) => n,
                Err(_) => return,
            };

            let request = String::from_utf8_lossy(&buf[..n]);

            // Parse the request line: GET /auth-callback?token=...&origin=... HTTP/1.1
            let path = match request.lines().next() {
                Some(line) => {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 && parts[0] == "GET" {
                        parts[1].to_string()
                    } else {
                        String::new()
                    }
                }
                None => String::new(),
            };

            if !path.starts_with("/auth-callback") {
                let response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
                return;
            }

            // Parse query params from the path
            let fake_url = format!("http://localhost{}", path);
            let parsed = match url::Url::parse(&fake_url) {
                Ok(u) => u,
                Err(_) => {
                    let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
            };

            let token = parsed
                .query_pairs()
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.to_string());
            let origin = parsed
                .query_pairs()
                .find(|(k, _)| k == "origin")
                .map(|(_, v)| v.to_string());
            let desktop_state = parsed
                .query_pairs()
                .find(|(k, _)| k == "desktop_state")
                .map(|(_, v)| v.to_string());

            match (token, desktop_state) {
                (Some(ref t), Some(ref state))
                    if is_valid_token_format(t)
                        && consume_pending_desktop_auth_state(&handle, state) =>
                {
                    let origin = origin
                        .filter(|o| validate_origin(o))
                        .unwrap_or_else(|| "http://localhost:3000".to_string());

                    let encoded_token: String =
                        url::form_urlencoded::byte_serialize(t.as_bytes()).collect();
                    let encoded_state: String =
                        url::form_urlencoded::byte_serialize(state.as_bytes()).collect();
                    let callback_url = format!(
                        "{}/desktop-callback?token={}&desktop_state={}",
                        origin, encoded_token, encoded_state
                    );

                    log::info!("Dev auth: navigating to callback");

                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.set_focus();
                        if let Ok(parsed_url) = callback_url.parse() {
                            let _ = window.navigate(parsed_url);
                        }
                    }

                    // Return a page that tells the user to close the tab
                    let body = r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth Complete</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fff}h1{font-size:1.5rem}</style></head><body><h1>Authentication complete. You can close this tab.</h1><script>window.close()</script></body></html>"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                }
                _ => {
                    log::warn!("Dev auth: invalid or missing token/auth state");
                    let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            }
        });
    }
}

fn get_last_update_check_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("last_update_check"))
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

fn deep_link_log_label(url: &url::Url) -> String {
    let mut label = format!("{}:", url.scheme());
    if let Some(host) = url.host_str() {
        label.push_str("//");
        label.push_str(host);
    }
    label.push_str(url.path());
    label
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

fn consume_pending_desktop_auth_state(app: &tauri::AppHandle, desktop_state: &str) -> bool {
    if !is_valid_token_format(desktop_state) {
        return false;
    }

    let Some(pending_states) = app.try_state::<PendingDesktopAuthStates>() else {
        log::error!("Desktop auth state store is unavailable");
        return false;
    };

    let now = SystemTime::now();
    let mut states = match pending_states.0.lock() {
        Ok(states) => states,
        Err(_) => {
            log::error!("Desktop auth state lock poisoned");
            return false;
        }
    };

    prune_expired_auth_states(&mut states, now);
    states
        .remove(desktop_state)
        .map(|expires_at| expires_at > now)
        .unwrap_or(false)
}

fn handle_auth_deep_link(app: &tauri::AppHandle, url: &url::Url) {
    if url.scheme() != "hackerai" {
        return;
    }

    if url.host_str() == Some("auth") || url.path() == "/auth" || url.path() == "auth" {
        match url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v)
        {
            Some(token) => {
                if !is_valid_token_format(&token) {
                    log::error!("Invalid token format in deep link");
                    return;
                }

                let desktop_state = match url
                    .query_pairs()
                    .find(|(k, _)| k == "desktop_state")
                    .map(|(_, v)| v.to_string())
                {
                    Some(state) if consume_pending_desktop_auth_state(app, &state) => state,
                    _ => {
                        log::error!("Auth deep link missing valid desktop auth state");
                        return;
                    }
                };

                if let Some(window) = app.get_webview_window("main") {
                    // Get and validate origin from deep link query params
                    let origin = url
                        .query_pairs()
                        .find(|(k, _)| k == "origin")
                        .map(|(_, v)| v.to_string())
                        .filter(|o| validate_origin(o))
                        .unwrap_or_else(|| {
                            log::warn!("Deep link has missing or invalid origin, using production");
                            "https://hackerai.co".to_string()
                        });

                    let encoded_token: String =
                        url::form_urlencoded::byte_serialize(token.as_bytes()).collect();
                    let encoded_state: String =
                        url::form_urlencoded::byte_serialize(desktop_state.as_bytes()).collect();
                    let callback_url = format!(
                        "{}/desktop-callback?token={}&desktop_state={}",
                        origin, encoded_token, encoded_state
                    );
                    log::info!("Navigating to desktop callback");

                    match callback_url.parse() {
                        Ok(parsed_url) => {
                            if window.navigate(parsed_url).is_err() {
                                log::error!("Failed to navigate to callback URL");
                                // Try to navigate to error page
                                let error_url = format!("{}/login?error=navigation_failed", origin);
                                if let Ok(error_parsed) = error_url.parse() {
                                    let _ = window.navigate(error_parsed);
                                }
                            }
                        }
                        Err(_) => {
                            log::error!("Invalid callback URL format");
                        }
                    }
                }
            }
            None => {
                if url.query_pairs().any(|(k, _)| k == "error") {
                    log::error!("Auth deep link received with an error");
                } else {
                    log::warn!(
                        "Auth deep link received without token: {}",
                        deep_link_log_label(url)
                    );
                }
            }
        }
    }
}

async fn check_update(
    builder: tauri_plugin_updater::UpdaterBuilder,
    check_timeout: Duration,
    download_timeout: Duration,
) -> tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>> {
    let updater = builder.timeout(check_timeout).build()?;
    let mut update = updater.check().await?;
    if let Some(update) = update.as_mut() {
        // The updater does not propagate the check timeout to the returned download.
        // Bound HTTP activity without timing out user approval or native installation.
        update.timeout = Some(download_timeout);
    }
    Ok(update)
}

// Attach updater prompts to the app window. Parentless macOS alerts use a
// separate system notification surface and can leave the app awaiting an
// approval that is not visible in its window.
fn update_dialog(
    app: &tauri::AppHandle,
    message: impl Into<String>,
) -> tauri_plugin_dialog::MessageDialogBuilder<tauri::Wry> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().message(message);
    match app.get_webview_window("main") {
        Some(window) => dialog.parent(&window),
        None => dialog,
    }
}

async fn check_for_updates(app: tauri::AppHandle, silent: bool) {
    let Some(_check) = update_safety::CheckGuard::acquire() else { return; };
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

    match check_update(
        app.updater_builder(),
        UPDATE_CHECK_TIMEOUT,
        UPDATE_DOWNLOAD_TIMEOUT,
    )
    .await
    {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("Update available: {}", version);

            let should_update = update_dialog(&app, format!(
                    "Version {} is available. Download the update? You will be asked before anything is installed.",
                    version
                ))
                .title("Update Available")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Download".into(), "Not now".into()))
                .blocking_show();

            if should_update {
                let bytes = match update.download(|_, _| {}, || {}).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        log::warn!("Desktop update download or signature verification failed: {error}");
                        update_dialog(&app, "The update could not be downloaded or verified. Your current app has not been changed. Choose Help > Check for Updates to try again.")
                            .kind(MessageDialogKind::Error).title("Update download failed").blocking_show();
                        return;
                    }
                };
                // Windows exits inside install(), so this is the final consent
                // on every platform. Never put restart approval after install.
                let approved = update_dialog(&app, format!("Install version {}? Desktop will close. Save your work and close terminal sessions first. It will not install while local commands or file operations are active. If Desktop does not reopen, open it yourself to confirm the version.", version))
                    .title("Ready to install")
                    .buttons(MessageDialogButtons::OkCancelCustom("Install now".into(), "Later".into()))
                    .blocking_show();
                if !approved {
                    return;
                }
                let directory = match app.path().app_data_dir() {
                    Ok(directory) => directory,
                    Err(_) => {
                        update_dialog(
                            &app,
                            "The update could not be prepared. No installation was started.",
                        )
                        .title("Update not started")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                        return;
                    }
                };
                let mut download = Some(bytes);
                loop {
                    let result = update_safety::install_after_approval(
                        &update_safety::UPDATE_GATE,
                        &directory,
                        &app.package_info().version.to_string(),
                        &version,
                        approved,
                        || {
                            let bytes = download
                                .take()
                                .expect("verified download available before installation");
                            update.install(bytes).map_err(|error| {
                                log::error!("Desktop update installation failed: {error}");
                                "The installer reported an error, and Desktop cannot confirm what changed. Close and reopen HackerAI Desktop to check its version before trying again.".to_string()
                            })?;
                            app.restart();
                        },
                    );
                    match result {
                        Err(message) if download.is_some() => {
                            // A busy gate or receipt failure never handed bytes to
                            // the installer. Keep the verified download for retry.
                            let retry = update_dialog(&app, format!("{}\n\nChoose Install now to try again. Desktop will close.", message))
                                .title("Update not started")
                                .buttons(MessageDialogButtons::OkCancelCustom("Install now".into(), "Later".into()))
                                .blocking_show();
                            if !retry {
                                return;
                            }
                        }
                        Err(message) => {
                            update_dialog(&app, message)
                                .title("Update did not finish")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                            return;
                        }
                        Ok(()) => return,
                    }
                }
            }
        }
        Ok(None) => {
            if silent {
                log::info!("No updates available (auto-check)");
            } else {
                log::info!("No updates available");
                let _ = update_dialog(&app, "You're running the latest version.")
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
                let _ = update_dialog(&app, format!("Failed to check for updates: {}", e))
                    .kind(MessageDialogKind::Error)
                    .title("Update Error")
                    .blocking_show();
            }
        }
    }
}

// ── PTY Commands ─────────────────────────────────────────────────────

type PtyState = std::sync::Arc<std::sync::Mutex<pty::PtyManager>>;

#[tauri::command]
async fn execute_pty_create(
    state: tauri::State<'_, PtyState>,
    session_id: String,
    command: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    on_data: tauri::ipc::Channel<String>,
) -> Result<pty::PtyCreateResult, String> {
    let mut manager = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    manager.create(session_id, command, cols, rows, cwd, env, on_data)
}

#[tauri::command]
async fn execute_pty_input(
    state: tauri::State<'_, PtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let writer = {
        let manager = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        manager.input_writer(&session_id)?
    };
    // Backpressure must not hold manager locks or block a Tauri async worker.
    tauri::async_runtime::spawn_blocking(move || pty::PtyManager::write_input(writer, &data))
        .await
        .map_err(|error| format!("PTY input task failed: {}", error))?
}

#[tauri::command]
async fn execute_pty_resize(
    state: tauri::State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    manager.resize(&session_id, cols, rows)
}

#[tauri::command]
async fn execute_pty_kill(
    state: tauri::State<'_, PtyState>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    manager.kill(&session_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedPtyCreate {
    session_id: String,
    command: String,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedPtyInput {
    session_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedPtyResize {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizedPtyKill {
    session_id: String,
}

#[tauri::command]
async fn execute_authorized_pty_create(
    state: tauri::State<'_, PtyState>,
    window: tauri::WebviewWindow,
    authorization_id: String,
    message: serde_json::Value,
    on_data: tauri::ipc::Channel<String>,
) -> Result<pty::PtyCreateResult, String> {
    let message = redeem_authorized_message(&authorization_id, message, &window).await?;
    authorized_operation_type(&message, &["pty_create"])?;
    let request: AuthorizedPtyCreate =
        serde_json::from_value(message).map_err(|_| "Invalid authorized PTY".to_string())?;
    execute_pty_create(
        state,
        request.session_id,
        request.command,
        request.cols.unwrap_or(80),
        request.rows.unwrap_or(24),
        request.cwd,
        request.env,
        on_data,
    )
    .await
}

#[tauri::command]
async fn execute_authorized_pty_input(
    state: tauri::State<'_, PtyState>,
    window: tauri::WebviewWindow,
    authorization_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let message = redeem_authorized_message(&authorization_id, message, &window).await?;
    authorized_operation_type(&message, &["pty_input"])?;
    let request: AuthorizedPtyInput =
        serde_json::from_value(message).map_err(|_| "Invalid authorized PTY input".to_string())?;
    execute_pty_input(state, request.session_id, request.data).await
}

#[tauri::command]
async fn execute_authorized_pty_resize(
    state: tauri::State<'_, PtyState>,
    window: tauri::WebviewWindow,
    authorization_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let message = redeem_authorized_message(&authorization_id, message, &window).await?;
    authorized_operation_type(&message, &["pty_resize"])?;
    let request: AuthorizedPtyResize =
        serde_json::from_value(message).map_err(|_| "Invalid authorized PTY resize".to_string())?;
    execute_pty_resize(state, request.session_id, request.cols, request.rows).await
}

#[tauri::command]
async fn execute_authorized_pty_kill(
    state: tauri::State<'_, PtyState>,
    window: tauri::WebviewWindow,
    authorization_id: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let message = redeem_authorized_message(&authorization_id, message, &window).await?;
    authorized_operation_type(&message, &["pty_kill"])?;
    let request: AuthorizedPtyKill =
        serde_json::from_value(message).map_err(|_| "Invalid authorized PTY kill".to_string())?;
    execute_pty_kill(state, request.session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_operation_digest_matches_server_canonical_json() {
        let message = serde_json::json!({
            "type": "command",
            "commandId": "cmd-1",
            "command": "printf safe",
            "env": { "B": "2", "A": "1" },
            "targetConnectionId": "desktop-1",
        });
        assert_eq!(
            authorized_message_digest(&message).unwrap(),
            "ff460f40034c348f7eba59c682589ea4af814bb8287bc49c3a44ab46b6e53405"
        );
        let unicode = serde_json::json!({
            "type": "command",
            "command": "printf 'π\\n' && echo 🔒",
            "env": { "LANG": "en_US.UTF-8" },
        });
        assert_eq!(
            authorized_message_digest(&unicode).unwrap(),
            "7ac733d7b148971df6b6f1c0b540f44d1bfb5c2517b2dc5c8008eb334426e080"
        );
    }

    #[test]
    fn authorization_uses_the_loaded_trusted_origin() {
        let production = url::Url::parse("https://hackerai.co/chat/task").unwrap();
        assert_eq!(
            desktop_authorization_endpoint(&production).unwrap(),
            "https://hackerai.co/api/desktop/authorized-operation"
        );
        let local = url::Url::parse("http://localhost:3000/chat/task").unwrap();
        assert_eq!(
            desktop_authorization_endpoint(&local).unwrap(),
            "http://localhost:3000/api/desktop/authorized-operation"
        );
        let untrusted = url::Url::parse("https://hackerai.co.evil.invalid/").unwrap();
        assert!(desktop_authorization_endpoint(&untrusted).is_err());
    }

    #[test]
    fn authorization_send_diagnostics_classify_origin_and_parse_optional_channel() {
        use authorization_send_diagnostics::OriginClass;
        for (url, class) in [
            (
                "https://hackerai.co/chat/task",
                OriginClass::CanonicalProduction,
            ),
            ("https://hackerai.co:8443/", OriginClass::OtherAllowed),
            ("http://localhost:3000/chat", OriginClass::Localhost),
            ("https://preview.example.test/", OriginClass::OtherAllowed),
            ("data:text/plain,hackerai.co", OriginClass::Unknown),
        ] {
            assert_eq!(
                authorization_origin_class(&url::Url::parse(url).unwrap()),
                class
            );
        }
        assert!(
            authorization_diagnostic_channel_id(Some(serde_json::json!("__CHANNEL__:7"))).is_some()
        );
        for value in [
            None,
            Some(serde_json::Value::Null),
            Some(serde_json::json!(7)),
            Some(serde_json::json!("7")),
            Some(serde_json::json!("__CHANNEL__:x")),
            Some(serde_json::json!({ "id": 7 })),
        ] {
            assert!(authorization_diagnostic_channel_id(value).is_none());
        }
    }

    // The published v1 command ABI has no cause-channel argument. Exercise that
    // ABI with the pinned Tauri binding, rather than assuming extra arguments
    // from a newer frontend are ignored. No native process can run here.
    #[tauri::command(rename = "execute_authorized_stream_command")]
    async fn legacy_authorized_command_fixture<R: tauri::Runtime>(
        window: tauri::WebviewWindow<R>,
        authorization_id: String,
        message: serde_json::Value,
        on_event: tauri::ipc::Channel<StreamEvent>,
        on_authorization_diagnostic: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let _ = (on_event, on_authorization_diagnostic);
        redeem_authorized_message(&authorization_id, message, &window)
            .await
            .map(|_| ())
    }

    #[test]
    fn authorization_send_diagnostics_optional_argument_keeps_original_command_errors() {
        use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
        // The compiled ACL admits the trusted IPC origin, while the loaded page
        // is untrusted for authorization: no POST can be attempted.
        for legacy_abi in [false, true] {
            let builder = mock_builder().manage(StreamCommandState::default());
            let builder = if legacy_abi {
                builder.invoke_handler(tauri::generate_handler![legacy_authorized_command_fixture])
            } else {
                builder.invoke_handler(tauri::generate_handler![execute_authorized_stream_command])
            };
            let app = builder.build(app_context()).unwrap();
            let untrusted_page =
                tauri::WebviewUrl::External("https://untrusted.invalid/".parse().unwrap());
            let window = tauri::WebviewWindowBuilder::new(&app, "main", untrusted_page)
                .build()
                .unwrap();
            type Optional = Option<serde_json::Value>;
            let invoke = |authorization_id: &str, (diagnostic, cause): (Optional, Optional)| {
                let mut body = serde_json::json!({
                    "authorizationId": authorization_id,
                    "message": { "type": "command", "commandId": "synthetic", "command": "true" },
                    "onEvent": "__CHANNEL__:1",
                });
                if let Some(value) = diagnostic {
                    body["onAuthorizationDiagnostic"] = value;
                }
                if let Some(value) = cause {
                    body["onAuthorizationCauseDiagnostic"] = value;
                }
                get_ipc_response(
                    &window,
                    tauri::webview::InvokeRequest {
                        cmd: "execute_authorized_stream_command".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: "https://hackerai.co/".parse().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(body),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.to_string(),
                    },
                )
                .map(|_| ())
            };
            let optional = [
                None,
                Some(serde_json::Value::Null),
                Some(serde_json::json!(42)),
                Some(serde_json::json!("not-a-channel")),
                Some(serde_json::json!("__CHANNEL__:2")),
            ];
            // Each optional channel alone, then both together as current frontends send them.
            let variants: Vec<_> = optional
                .iter()
                .map(|value| (value.clone(), None))
                .chain(optional.iter().map(|value| (None, value.clone())))
                .chain([(
                    Some(serde_json::json!("__CHANNEL__:2")),
                    Some(serde_json::json!("__CHANNEL__:3")),
                )])
                .collect();
            for variant in variants.clone() {
                assert_eq!(
                    invoke("invalid", variant),
                    Err(serde_json::json!("Invalid Desktop operation authorization"))
                );
            }
            let valid_id = "a".repeat(64);
            for variant in variants.clone() {
                assert_eq!(
                    invoke(&valid_id, variant),
                    Err(serde_json::json!(
                        "Desktop origin is not allowed for native authorization"
                    ))
                );
            }
        }
    }

    #[tokio::test]
    async fn stream_cancel_before_launch_prevents_a_native_process() {
        let state = StreamCommandState::default();
        assert_eq!(
            request_stream_command_cancel(&state, "stopped").unwrap(),
            None
        );
        let mut cmd = platform::build_command("echo should-not-run", None, None);
        assert!(spawn_stream_command(&state, "stopped", &mut cmd)
            .unwrap()
            .is_none());
        // A duplicate late delivery must remain canceled as well.
        assert!(spawn_stream_command(&state, "stopped", &mut cmd)
            .unwrap()
            .is_none());
        let mut replacement = platform::build_command("echo replacement", None, None);
        let mut child = spawn_stream_command(&state, "replacement", &mut replacement)
            .unwrap()
            .unwrap();
        assert!(child.wait().await.unwrap().success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stream_cancel_after_launch_stops_the_registered_process_group() {
        let state = StreamCommandState::default();
        let mut cmd = platform::build_command("sleep 30", None, None);
        cmd.kill_on_drop(true);
        let mut child = spawn_stream_command(&state, "running", &mut cmd)
            .unwrap()
            .unwrap();
        let pid = request_stream_command_cancel(&state, "running")
            .unwrap()
            .unwrap();
        assert_eq!(Some(pid), child.id());
        // Reap concurrently: an unreaped shell can keep its process group alive.
        let (canceled, exited) = tokio::join!(platform::cancel_process_tree(pid), child.wait());
        assert!(canceled);
        assert!(!exited.unwrap().success());
        state.lock().unwrap().running.remove("running");
        assert!(spawn_stream_command(&state, "running", &mut cmd)
            .unwrap()
            .is_none());
    }

    fn unique_test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "hackerai-desktop-{}-{}",
            label,
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn deep_link_log_label_omits_authentication_query_values() {
        let token = "a".repeat(64);
        let desktop_state = "b".repeat(64);
        let url = url::Url::parse(&format!(
            "hackerai://auth?token={token}&origin=https%3A%2F%2Fhackerai.co&desktop_state={desktop_state}"
        ))
        .expect("valid deep link");

        let label = deep_link_log_label(&url);

        assert_eq!(label, "hackerai://auth");
        assert!(!label.contains(&token));
        assert!(!label.contains(&desktop_state));
        assert!(!label.contains("origin"));
    }

    #[tokio::test]
    async fn file_write_allows_nested_paths_inside_allowed_root() {
        let root = unique_test_dir("allowed-root");
        fs::create_dir_all(&root).expect("create allowed root");
        let target = root.join("src").join("app.ts");
        let body = serde_json::json!({
            "path": target.to_string_lossy().to_string(),
            "content": "updated",
            "allowed_root": root.to_string_lossy().to_string(),
        })
        .to_string();

        let result = handle_file_write(&body).await;

        assert!(result.is_ok(), "{result:?}");
        let content = fs::read_to_string(&target).expect("written file should exist");
        assert_eq!(content, "updated");
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn desktop_file_request_dispatches_write_and_read_over_ipc() {
        let root = unique_test_dir("ipc-round-trip");
        fs::create_dir_all(&root).expect("create root");
        let target = root.join("notes.txt");

        let write_result = dispatch_desktop_file_request(serde_json::json!({
            "type": "file_write",
            "path": target.to_string_lossy().to_string(),
            "content": "written over ipc",
            "allowed_root": root.to_string_lossy().to_string(),
        }))
        .await;
        assert_eq!(
            write_result.expect("IPC write should succeed"),
            serde_json::json!({ "ok": true })
        );

        let read_result = dispatch_desktop_file_request(serde_json::json!({
            "type": "file_read",
            "path": target.to_string_lossy().to_string(),
            "max_full_bytes": 1024,
            "max_result_bytes": 1024,
        }))
        .await
        .expect("IPC read should succeed");
        assert_eq!(read_result["content"], "written over ipc");
        assert_eq!(read_result["path"], target.to_string_lossy().as_ref());

        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn desktop_file_request_rejects_unknown_operations() {
        let result = dispatch_desktop_file_request(serde_json::json!({
            "type": "file_execute",
            "path": "/tmp/not-used",
        }))
        .await;

        assert_eq!(
            result.expect_err("unknown operation should fail"),
            "Unsupported desktop file request type: file_execute"
        );
    }

    #[tokio::test]
    async fn file_write_preserves_unscoped_desktop_compatibility() {
        let root = unique_test_dir("unscoped");
        let target = root.join("notes.txt");
        let body = serde_json::json!({
            "path": target.to_string_lossy().to_string(),
            "content": "updated",
        })
        .to_string();

        let result = handle_file_write(&body).await;

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            fs::read_to_string(&target).expect("written file should exist"),
            "updated"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn file_append_allows_existing_files_inside_allowed_root() {
        let root = unique_test_dir("allowed-append-root");
        fs::create_dir_all(&root).expect("create allowed root");
        let target = root.join("notes.txt");
        fs::write(&target, "first").expect("seed target");
        let body = serde_json::json!({
            "path": target.to_string_lossy().to_string(),
            "content": " second",
            "allowed_root": root.to_string_lossy().to_string(),
        })
        .to_string();

        let result = handle_file_append(&body).await;

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            fs::read_to_string(&target).expect("appended file should exist"),
            "first second"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn file_write_rejects_parent_traversal_from_allowed_root() {
        let root = unique_test_dir("traversal-root");
        let external = unique_test_dir("traversal-external");
        fs::create_dir_all(&root).expect("create root");
        let external_target = root
            .join("..")
            .join(external.file_name().expect("external basename"))
            .join("outside.txt");
        let body = serde_json::json!({
            "path": external_target.to_string_lossy().to_string(),
            "content": "overwritten",
            "allowed_root": root.to_string_lossy().to_string(),
        })
        .to_string();

        let result = handle_file_write(&body).await;

        assert!(result.is_err(), "{result:?}");
        assert!(!external_target.exists());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&external);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_write_rejects_symlink_escape_from_allowed_root() {
        use std::os::unix::fs::symlink;

        let root = unique_test_dir("symlink-root");
        let external = unique_test_dir("symlink-external");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&external).expect("create external");
        let external_target = external.join("secret.txt");
        fs::write(&external_target, "secret").expect("seed external target");
        let project_link = root.join("linked-secret.txt");
        symlink(&external_target, &project_link).expect("create symlink");
        let body = serde_json::json!({
            "path": project_link.to_string_lossy().to_string(),
            "content": "overwritten",
            "allowed_root": root.to_string_lossy().to_string(),
        })
        .to_string();

        let result = handle_file_write(&body).await;

        assert!(result.is_err(), "{result:?}");
        assert_eq!(
            fs::read_to_string(&external_target).expect("external target should remain"),
            "secret"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&external);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_write_rejects_parent_symlink_escape_from_allowed_root() {
        use std::os::unix::fs::symlink;

        let root = unique_test_dir("parent-symlink-root");
        let external = unique_test_dir("parent-symlink-external");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&external).expect("create external");
        let project_link = root.join("linked-directory");
        symlink(&external, &project_link).expect("create directory symlink");
        let target = project_link.join("secret.txt");
        let body = serde_json::json!({
            "path": target.to_string_lossy().to_string(),
            "content": "overwritten",
            "allowed_root": root.to_string_lossy().to_string(),
        })
        .to_string();

        let result = handle_file_write(&body).await;

        assert!(result.is_err(), "{result:?}");
        assert!(!external.join("secret.txt").exists());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&external);
    }
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            if let Some(tauri::menu::MenuItemKind::Submenu(help)) = menu.get(tauri::menu::HELP_SUBMENU_ID) {
                help.append(&tauri::menu::MenuItem::with_id(app, "check-for-updates", "Check for Updates…", true, None::<&str>)?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "check-for-updates" {
                tauri::async_runtime::spawn(check_for_updates(app.clone(), false));
            }
        })
        .invoke_handler(tauri::generate_handler![
            environment_identity::get_environment_id,
            get_dev_auth_port,
            prepare_desktop_auth_state,
            pick_local_files,
            save_file_with_dialog,
            save_binary_file_with_dialog,
            open_downloads_folder,
            authorized_desktop_file_request,
            probe_desktop_file_bridge,
            get_local_file_metadata,
            write_generated_text_attachment,
            read_generated_text_attachment,
            remove_generated_text_attachment,
            read_local_file,
            read_local_preview_file,
            get_desktop_os_info,
            get_command_stdin_support,
            execute_authorized_stream_command,
            cancel_stream_command,
            execute_authorized_pty_create,
            execute_authorized_pty_input,
            execute_authorized_pty_resize,
            execute_authorized_pty_kill,
            execute_pty_kill
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
            log::info!(
                "Single instance callback with {} argument(s)",
                args.len()
            );
            for arg in args.iter().skip(1) {
                if let Ok(url) = url::Url::parse(arg) {
                    if url.scheme() == "hackerai" {
                        log::info!(
                            "Processing deep link from CLI arg: {}",
                            deep_link_log_label(&url)
                        );
                        handle_auth_deep_link(app, &url);
                    }
                }
            }
            // Focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(std::sync::Arc::new(std::sync::Mutex::new(pty::PtyManager::new())) as PtyState)
        .manage(
            std::sync::Arc::new(std::sync::Mutex::new(StreamCommandRegistry::default()))
                as StreamCommandState,
        )
        .manage(PendingDesktopAuthStates(std::sync::Mutex::new(
            HashMap::new(),
        )))
        .manage(SelectedLocalFiles(std::sync::Mutex::new(HashSet::new())))
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
                    log::info!(
                        "Deep link callback received with {} URL(s)",
                        urls.len()
                    );

                    for url in urls {
                        log::info!(
                            "Processing deep link: {}",
                            deep_link_log_label(&url)
                        );
                        handle_auth_deep_link(&handle, &url);
                    }
                });
            }
            // Start dev auth callback server when running in debug mode
            // (deep links don't work with `tauri dev` on macOS)
            #[cfg(debug_assertions)]
            {
                let dev_handle = app.handle().clone();
                tauri::async_runtime::spawn(start_dev_auth_server(dev_handle));
            }

            // Check for updates on every launch
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_dialog::MessageDialogKind;
                if let Ok(directory) = handle.path().app_data_dir() {
                    match update_safety::Receipt::take(&directory, &handle.package_info().version.to_string()) {
                        Ok(Some((receipt, update_safety::RestartResult::Applied))) => {
                            log::info!("Desktop update verified after restart: {}", receipt.target);
                        }
                        Ok(Some((receipt, update_safety::RestartResult::NotApplied))) => {
                            update_dialog(&handle, format!("The update to {} did not finish. This app is still version {}. You can try the update again.", receipt.target, receipt.from))
                                .title("Update needs another attempt").kind(MessageDialogKind::Warning).blocking_show();
                        }
                        Ok(_) => {},
                        Err(_) => log::warn!("Desktop update verification unavailable; continuing startup"),
                    }
                }
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
        .build(app_context())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(pty_state) = app.try_state::<PtyState>() {
                    if let Ok(mut manager) = pty_state.lock() {
                        manager.stop_all();
                    }
                }
            }
        });
}
