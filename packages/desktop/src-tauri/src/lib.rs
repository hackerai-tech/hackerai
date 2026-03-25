mod platform;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60); // 24 hours

/// Port for the local dev auth callback server (0 = not started)
static DEV_AUTH_PORT: AtomicU16 = AtomicU16::new(0);

/// Port for the command execution server (0 = not started)
static CMD_SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Session token for authenticating command server requests
static CMD_SERVER_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

static CONVEX_URL: std::sync::OnceLock<tokio::sync::RwLock<String>> = std::sync::OnceLock::new();
static CONVEX_AUTH_TOKEN: std::sync::OnceLock<tokio::sync::RwLock<String>> = std::sync::OnceLock::new();
static NOTES_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn convex_url_lock() -> &'static tokio::sync::RwLock<String> {
    CONVEX_URL.get_or_init(|| tokio::sync::RwLock::new(String::new()))
}

fn convex_auth_token_lock() -> &'static tokio::sync::RwLock<String> {
    CONVEX_AUTH_TOKEN.get_or_init(|| tokio::sync::RwLock::new(String::new()))
}

/// Get the dev auth callback port (0 if not running in dev mode)
#[tauri::command]
fn get_dev_auth_port() -> u16 {
    DEV_AUTH_PORT.load(Ordering::Relaxed)
}

/// Get the command server port, session token, and OS info
#[tauri::command]
fn get_cmd_server_info() -> CmdServerInfo {
    CmdServerInfo {
        port: CMD_SERVER_PORT.load(Ordering::Relaxed),
        token: CMD_SERVER_TOKEN.get().cloned().unwrap_or_default(),
    }
}

#[derive(Serialize)]
struct CmdServerInfo {
    port: u16,
    token: String,
}

#[tauri::command]
async fn set_convex_auth(url: String, token: String, notes_enabled: bool) -> Result<(), String> {
    *convex_url_lock().write().await = url.clone();
    *convex_auth_token_lock().write().await = token;
    NOTES_ENABLED.store(notes_enabled, Ordering::Relaxed);
    log::info!("Convex auth updated (url: {}, notes: {})", url, notes_enabled);
    Ok(())
}

// ── Convex API Helper ────────────────────────────────────────────────

async fn call_convex_function(function_path: &str, args: serde_json::Value, is_mutation: bool) -> Result<String, String> {
    let url = convex_url_lock().read().await.clone();
    let auth_token = convex_auth_token_lock().read().await.clone();

    if url.is_empty() || auth_token.is_empty() {
        return Err("Convex not configured. Notes API unavailable.".to_string());
    }

    let endpoint = if is_mutation {
        format!("{}/api/mutation", url)
    } else {
        format!("{}/api/query", url)
    };

    let body = serde_json::json!({
        "path": function_path,
        "args": args,
        "format": "json"
    });

    let client = reqwest::Client::new();
    let resp = client.post(&endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Convex request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Convex error ({})", status));
    }

    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(parsed) => {
            if let Some(value) = parsed.get("value") {
                serde_json::to_string(value).map_err(|e| format!("Serialize error: {}", e))
            } else if let Some(err) = parsed.get("errorMessage") {
                Err(format!("Convex error: {}", err))
            } else {
                Err("Unexpected Convex response format".to_string())
            }
        }
        Err(_) => Err("Unexpected response format from Convex".to_string()),
    }
}

// ── Notes API ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct NoteCreateRequest {
    title: String,
    content: String,
    #[serde(default = "default_note_category")]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
}

fn default_note_category() -> String {
    "general".to_string()
}

#[derive(Deserialize)]
struct NoteUpdateRequest {
    #[serde(alias = "noteId", alias = "note_id")]
    note_id: String,
    title: Option<String>,
    content: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct NoteDeleteRequest {
    #[serde(alias = "noteId", alias = "note_id")]
    note_id: String,
}

async fn handle_notes_list(query_string: &str) -> Result<String, String> {
    let mut category: Option<String> = None;
    if !query_string.is_empty() {
        for pair in query_string.split('&') {
            if let Some(val) = pair.strip_prefix("category=") {
                category = Some(urldecode(val));
            }
        }
    }

    let mut args = serde_json::json!({});
    if let Some(cat) = category {
        args["category"] = serde_json::Value::String(cat);
    }

    call_convex_function("notes:getUserNotes", args, false).await
}

async fn handle_notes_create(body: &str) -> Result<String, String> {
    let req: NoteCreateRequest = serde_json::from_str(body)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut args = serde_json::json!({
        "title": req.title,
        "content": req.content,
        "category": req.category,
    });
    if !req.tags.is_empty() {
        args["tags"] = serde_json::json!(req.tags);
    }

    call_convex_function("notes:createUserNote", args, true).await
}

async fn handle_notes_update(body: &str) -> Result<String, String> {
    let req: NoteUpdateRequest = serde_json::from_str(body)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut args = serde_json::json!({
        "noteId": req.note_id,
    });
    if let Some(title) = req.title {
        args["title"] = serde_json::Value::String(title);
    }
    if let Some(content) = req.content {
        args["content"] = serde_json::Value::String(content);
    }
    if let Some(tags) = req.tags {
        args["tags"] = serde_json::json!(tags);
    }

    call_convex_function("notes:updateUserNote", args, true).await
}

async fn handle_notes_delete(body: &str) -> Result<String, String> {
    let req: NoteDeleteRequest = serde_json::from_str(body)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let args = serde_json::json!({
        "noteId": req.note_id,
    });

    call_convex_function("notes:deleteUserNote", args, true).await
}

async fn handle_notes_search(query_string: &str) -> Result<String, String> {
    let mut search = String::new();
    let mut category: Option<String> = None;

    for pair in query_string.split('&') {
        if let Some(val) = pair.strip_prefix("q=") {
            search = urldecode(val);
        } else if let Some(val) = pair.strip_prefix("category=") {
            category = Some(urldecode(val));
        }
    }

    if search.is_empty() {
        return Err("Missing 'q' parameter".to_string());
    }

    let mut args = serde_json::json!({
        "search": search,
    });
    if let Some(cat) = category {
        args["category"] = serde_json::Value::String(cat);
    }

    call_convex_function("notes:searchUserNotes", args, false).await
}

fn urldecode(s: &str) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len());
    let mut chars = s.as_bytes().iter();
    while let Some(&b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next().copied();
            let h2 = chars.next().copied();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let hex = [h1, h2];
                if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&hex).unwrap_or(""), 16) {
                    bytes.push(byte);
                } else {
                    bytes.push(b'%');
                    bytes.push(h1);
                    bytes.push(h2);
                }
            } else {
                bytes.push(b'%');
                if let Some(h1) = h1 { bytes.push(h1); }
            }
        } else if b == b'+' {
            bytes.push(b' ');
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

// ── Command Execution Server ──────────────────────────────────────────

#[derive(Deserialize)]
struct ExecRequest {
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}

fn default_timeout() -> u64 {
    30000
}

#[derive(Serialize)]
struct ExecResponse {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Deserialize)]
struct FileReadRequest {
    path: String,
}

#[derive(Deserialize)]
struct FileWriteRequest {
    path: String,
    content: String,
    #[serde(default)]
    is_base64: bool,
}

#[derive(Deserialize)]
struct FileRemoveRequest {
    path: String,
}

#[derive(Deserialize)]
struct FileListRequest {
    path: String,
}

/// Start the local command execution HTTP server.
/// Binds to 127.0.0.1 only and requires a session token for all requests.
async fn start_cmd_server() {
    // Generate a random session token
    let token = uuid::Uuid::new_v4().to_string();
    let _ = CMD_SERVER_TOKEN.set(token.clone());

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to start command server: {}", e);
            return;
        }
    };

    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            log::error!("Failed to get command server address: {}", e);
            return;
        }
    };
    CMD_SERVER_PORT.store(port, Ordering::Relaxed);
    log::info!("Command server listening on http://127.0.0.1:{}", port);

    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                log::warn!("Command server accept error: {}", e);
                continue;
            }
        };

        // Only accept connections from localhost
        if !addr.ip().is_loopback() {
            log::warn!("Rejected non-loopback connection from {}", addr);
            continue;
        }

        let token = token.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_cmd_request(stream, &token).await {
                log::warn!("Command server request error: {}", e);
            }
        });
    }
}

/// Maximum allowed header size (256KB). Requests with headers exceeding this are rejected.
const MAX_HEADER_SIZE: usize = 256 * 1024;

/// Maximum allowed body size (10MB). Requests with bodies exceeding this are rejected.
const MAX_BODY_SIZE: usize = 10 * 1024 * 1024;

/// Parse an HTTP request from the stream, returning (method, path, headers, body)
async fn parse_http_request(stream: &mut tokio::net::TcpStream) -> Result<(String, String, HashMap<String, String>, String), String> {
    let mut buf = vec![0u8; 64 * 1024]; // 64KB initial buffer
    let mut total_read = 0;

    // Read headers first (with size cap to prevent OOM)
    loop {
        let n = stream.read(&mut buf[total_read..]).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Connection closed".into());
        }
        total_read += n;

        // Check if we have the full headers (search in bytes, not string)
        if buf[..total_read].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }

        // Reject oversized headers
        if total_read > MAX_HEADER_SIZE {
            return Err("Request headers too large".into());
        }

        // Grow buffer if needed (up to the cap)
        if total_read >= buf.len() {
            let new_size = (buf.len() * 2).min(MAX_HEADER_SIZE + 1);
            if new_size <= buf.len() {
                return Err("Request headers too large".into());
            }
            buf.resize(new_size, 0);
        }
    }

    // Find header/body boundary in raw bytes to avoid string/byte index mismatch
    let header_end = buf[..total_read].windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("No header end")?;
    let body_start_idx = header_end + 4;

    let header_section = String::from_utf8_lossy(&buf[..header_end]).to_string();

    // Parse request line
    let first_line = header_section.lines().next().ok_or("Empty request")?;
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("Invalid request line".into());
    }
    let method = parts[0].to_string();
    let path = parts[1].to_string();

    // Parse headers
    let mut headers = HashMap::new();
    for line in header_section.lines().skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }

    // Read body based on content-length
    let content_length: usize = headers.get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    if content_length > MAX_BODY_SIZE {
        return Err("Request body too large".into());
    }

    let body_bytes_read = total_read - body_start_idx;
    let mut body_buf = buf[body_start_idx..total_read].to_vec();

    // Read remaining body if needed
    if body_bytes_read < content_length {
        let remaining = content_length - body_bytes_read;
        let mut remaining_buf = vec![0u8; remaining];
        let mut read_so_far = 0;
        while read_so_far < remaining {
            let n = stream.read(&mut remaining_buf[read_so_far..]).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            read_so_far += n;
        }
        body_buf.extend_from_slice(&remaining_buf[..read_so_far]);
    }

    let body = String::from_utf8_lossy(&body_buf[..content_length.min(body_buf.len())]).to_string();

    Ok((method, path, headers, body))
}

async fn handle_cmd_request(mut stream: tokio::net::TcpStream, expected_token: &str) -> Result<(), String> {
    let (method, path, headers, body) = parse_http_request(&mut stream).await?;

    // CORS preflight
    if method == "OPTIONS" {
        let response = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Authorization\r\nAccess-Control-Max-Age: 86400\r\n\r\n";
        stream.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Validate auth token
    let auth_header = headers.get("authorization").cloned().unwrap_or_default();
    let provided_token = auth_header.strip_prefix("Bearer ").unwrap_or("");
    if provided_token != expected_token {
        let body = r#"{"error":"unauthorized"}"#;
        let response = format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
            body.len(), body
        );
        stream.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Streaming execute gets special handling (writes directly to stream)
    if method == "POST" && path == "/execute/stream" {
        return handle_execute_stream(&body, &mut stream).await;
    }

    let (route_path, query_string) = if let Some(idx) = path.find('?') {
        (&path[..idx], &path[idx+1..])
    } else {
        (path.as_str(), "")
    };

    // Check if notes are disabled for any /notes route
    if route_path.starts_with("/notes") && !NOTES_ENABLED.load(Ordering::Relaxed) {
        let resp_body = r#"{"error":"Notes are disabled. Please go to Settings > Personalization > Notes to enable them."}"#;
        let response = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
            resp_body.len(), resp_body
        );
        stream.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
        return Ok(());
    }

    let result = match (method.as_str(), route_path) {
        ("GET", "/notes") => handle_notes_list(query_string).await,
        ("POST", "/notes") => handle_notes_create(&body).await,
        ("PUT", "/notes") => handle_notes_update(&body).await,
        ("DELETE", "/notes") => handle_notes_delete(&body).await,
        ("GET", "/notes/search") => handle_notes_search(query_string).await,
        ("POST", "/execute") => handle_execute(&body).await,
        ("POST", "/files/read") => handle_file_read(&body).await,
        ("POST", "/files/write") => handle_file_write(&body).await,
        ("POST", "/files/remove") => handle_file_remove(&body).await,
        ("POST", "/files/list") => handle_file_list(&body).await,
        (_, "/health") => Ok(r#"{"status":"ok"}"#.to_string()),
        _ => Err("not found".to_string()),
    };

    let (status, resp_body) = match result {
        Ok(json) => ("200 OK", json),
        Err(e) if e == "not found" => ("404 Not Found", format!(r#"{{"error":"not found"}}"#)),
        Err(e) => ("500 Internal Server Error", format!(r#"{{"error":"{}"}}"#, e.replace('"', "\\\""))),
    };

    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
        status, resp_body.len(), resp_body
    );
    stream.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn handle_execute(body: &str) -> Result<String, String> {
    let req: ExecRequest = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut cmd = platform::build_command(
        &req.command,
        req.cwd.as_deref(),
        req.env.as_ref(),
    );

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;

    let timeout = Duration::from_millis(req.timeout_ms);
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("Process error: {}", e)),
        Err(_) => return Err(format!("Command timed out after {}ms", req.timeout_ms)),
    };

    // Truncate output to 1MB to prevent huge responses
    const MAX_OUTPUT: usize = 1024 * 1024;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout_str = if stdout.len() > MAX_OUTPUT {
        format!("{}... [truncated, {} total bytes]", &stdout[..MAX_OUTPUT], stdout.len())
    } else {
        stdout.to_string()
    };
    let stderr_str = if stderr.len() > MAX_OUTPUT {
        format!("{}... [truncated, {} total bytes]", &stderr[..MAX_OUTPUT], stderr.len())
    } else {
        stderr.to_string()
    };

    let resp = ExecResponse {
        stdout: stdout_str,
        stderr: stderr_str,
        exit_code: output.status.code().unwrap_or(-1),
    };

    serde_json::to_string(&resp).map_err(|e| format!("Serialize error: {}", e))
}

/// Streaming execute: sends NDJSON lines as stdout/stderr arrive, then a final
/// line with exit_code. Each line is one of:
///   {"type":"stdout","data":"..."}
///   {"type":"stderr","data":"..."}
///   {"type":"exit","exit_code":0}
///   {"type":"error","message":"..."}
async fn handle_execute_stream(body: &str, stream: &mut tokio::net::TcpStream) -> Result<(), String> {
    let req: ExecRequest = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;

    let mut cmd = platform::build_command(
        &req.command,
        req.cwd.as_deref(),
        req.env.as_ref(),
    );

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let err_body = format!(r#"{{"error":"Failed to spawn: {}"}}"#, e.to_string().replace('"', "\\\""));
            let resp = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\n\r\n{}",
                err_body.len(), err_body
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            return Ok(());
        }
    };

    // Send chunked response headers
    let headers = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nAccess-Control-Allow-Origin: *\r\nTransfer-Encoding: chunked\r\n\r\n";
    stream.write_all(headers.as_bytes()).await.map_err(|e| e.to_string())?;

    let timeout = Duration::from_millis(req.timeout_ms);
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let result = tokio::time::timeout(timeout, async {
        let mut stdout_buf = [0u8; 4096];
        let mut stderr_buf = [0u8; 4096];
        let mut stdout_done = false;
        let mut stderr_done = false;

        loop {
            if stdout_done && stderr_done {
                break;
            }

            tokio::select! {
                result = stdout.read(&mut stdout_buf), if !stdout_done => {
                    match result {
                        Ok(0) => stdout_done = true,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&stdout_buf[..n]);
                            let escaped = serde_json::to_string(&text).unwrap_or_default();
                            let line = format!(r#"{{"type":"stdout","data":{}}}"#, escaped);
                            write_chunk(stream, &line).await;
                        }
                        Err(_) => stdout_done = true,
                    }
                }
                result = stderr.read(&mut stderr_buf), if !stderr_done => {
                    match result {
                        Ok(0) => stderr_done = true,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&stderr_buf[..n]);
                            let escaped = serde_json::to_string(&text).unwrap_or_default();
                            let line = format!(r#"{{"type":"stderr","data":{}}}"#, escaped);
                            write_chunk(stream, &line).await;
                        }
                        Err(_) => stderr_done = true,
                    }
                }
            }
        }

        // Wait for process to exit
        child.wait().await
    }).await;

    match result {
        Ok(Ok(status)) => {
            let line = format!(r#"{{"type":"exit","exit_code":{}}}"#, status.code().unwrap_or(-1));
            write_chunk(stream, &line).await;
        }
        Ok(Err(e)) => {
            let line = format!(r#"{{"type":"error","message":"Process error: {}"}}"#, e.to_string().replace('"', "\\\""));
            write_chunk(stream, &line).await;
        }
        Err(_) => {
            // Timeout — gracefully kill the process
            platform::graceful_kill(&mut child).await;
            let line = format!(r#"{{"type":"error","message":"Command timed out after {}ms"}}"#, req.timeout_ms);
            write_chunk(stream, &line).await;
        }
    }

    // Terminal chunk
    write_chunk(stream, "").await;
    Ok(())
}

/// Write a single HTTP chunked-transfer chunk
async fn write_chunk(stream: &mut tokio::net::TcpStream, data: &str) {
    let payload = if data.is_empty() {
        "0\r\n\r\n".to_string()
    } else {
        let line = format!("{}\n", data);
        format!("{:x}\r\n{}\r\n", line.len(), line)
    };
    let _ = stream.write_all(payload.as_bytes()).await;
    let _ = stream.flush().await;
}

async fn handle_file_read(body: &str) -> Result<String, String> {
    let req: FileReadRequest = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let content = tokio::fs::read_to_string(&req.path).await.map_err(|e| format!("Read error: {}", e))?;
    serde_json::to_string(&serde_json::json!({ "content": content })).map_err(|e| e.to_string())
}

async fn handle_file_write(body: &str) -> Result<String, String> {
    let req: FileWriteRequest = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&req.path).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| format!("Mkdir error: {}", e))?;
    }

    if req.is_base64 {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&req.content)
            .map_err(|e| format!("Base64 decode error: {}", e))?;
        tokio::fs::write(&req.path, bytes).await.map_err(|e| format!("Write error: {}", e))?;
    } else {
        tokio::fs::write(&req.path, &req.content).await.map_err(|e| format!("Write error: {}", e))?;
    }

    Ok(r#"{"ok":true}"#.to_string())
}

async fn handle_file_remove(body: &str) -> Result<String, String> {
    let req: FileRemoveRequest = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let path = std::path::Path::new(&req.path);

    if path.is_dir() {
        tokio::fs::remove_dir_all(path).await.map_err(|e| format!("Remove error: {}", e))?;
    } else {
        tokio::fs::remove_file(path).await.map_err(|e| format!("Remove error: {}", e))?;
    }

    Ok(r#"{"ok":true}"#.to_string())
}

async fn handle_file_list(body: &str) -> Result<String, String> {
    let req: FileListRequest = serde_json::from_str(body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let mut entries = Vec::new();
    let mut dir = tokio::fs::read_dir(&req.path).await.map_err(|e| format!("ReadDir error: {}", e))?;

    while let Some(entry) = dir.next_entry().await.map_err(|e| format!("Entry error: {}", e))? {
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(serde_json::json!({ "name": name }));
    }

    serde_json::to_string(&entries).map_err(|e| e.to_string())
}

// ── Codex App Server Management (stdio + Tauri events) ─────────────

/// Whether the codex app-server is running
static CODEX_RUNNING: AtomicBool = AtomicBool::new(false);
/// Stdin handle for writing JSON-RPC messages to the app-server
static CODEX_STDIN: std::sync::OnceLock<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>> = std::sync::OnceLock::new();
/// PID of the codex app-server child process (for cleanup on exit)
static CODEX_PID: std::sync::OnceLock<std::sync::Mutex<Option<u32>>> = std::sync::OnceLock::new();

fn codex_stdin_lock() -> &'static tokio::sync::Mutex<Option<tokio::process::ChildStdin>> {
    CODEX_STDIN.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn codex_pid_lock() -> &'static std::sync::Mutex<Option<u32>> {
    CODEX_PID.get_or_init(|| std::sync::Mutex::new(None))
}

/// Clear stdin handle and running flag when the process exits.
fn codex_mark_stopped() {
    CODEX_RUNNING.store(false, Ordering::SeqCst);
    // Clear stdin so a new process can be started
    if let Some(lock) = CODEX_STDIN.get() {
        if let Ok(mut guard) = lock.try_lock() {
            *guard = None;
        }
    }
    if let Some(lock) = CODEX_PID.get() {
        if let Ok(mut guard) = lock.lock() {
            *guard = None;
        }
    }
}

/// Kill the codex app-server if it is running.
pub fn codex_kill() {
    if let Some(lock) = CODEX_PID.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(pid) = guard.take() {
                log::info!("Killing codex app-server (pid {})", pid);
                #[cfg(unix)]
                {
                    unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                }
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F"])
                        .spawn();
                }
            }
        }
    }
    codex_mark_stopped();
}

/// Start `codex app-server --listen stdio://` as a child process.
/// Stdout lines are emitted as Tauri events ("codex-rpc-event").
/// Stderr is drained and logged. Idempotent — returns immediately if already running.
#[tauri::command]
async fn start_codex_app_server(app: tauri::AppHandle) -> Result<bool, String> {
    // Atomic compare-exchange to prevent double-spawn race
    if CODEX_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Ok(true); // already running
    }

    let command = "codex app-server --listen stdio://";
    let mut cmd = platform::build_command(command, None, None);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        CODEX_RUNNING.store(false, Ordering::SeqCst);
        format!("Failed to spawn codex app-server: {}", e)
    })?;

    // Store PID for cleanup
    if let Some(pid) = child.id() {
        *codex_pid_lock().lock().unwrap() = Some(pid);
    }

    // Take stdin for writing JSON-RPC messages
    let stdin = child.stdin.take()
        .ok_or_else(|| { codex_mark_stopped(); "No stdin from codex app-server".to_string() })?;
    *codex_stdin_lock().lock().await = Some(stdin);

    // Take stdout — each line is a JSON-RPC message, emitted as Tauri event
    let stdout = child.stdout.take()
        .ok_or_else(|| { codex_mark_stopped(); "No stdout from codex app-server".to_string() })?;
    let app_handle = app.clone();
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    log::info!("codex app-server stdout EOF");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim().to_string();
                    if !trimmed.is_empty() {
                        let _ = app_handle.emit("codex-rpc-event", trimmed);
                    }
                }
                Err(e) => {
                    log::error!("codex app-server stdout error: {}", e);
                    break;
                }
            }
        }
    });

    // Drain stderr in background
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => log::info!("codex app-server stderr: {}", line.trim()),
                    Err(_) => break,
                }
            }
        });
    }

    // Wait for process exit and clean up
    tokio::spawn(async move {
        let _ = child.wait().await;
        log::info!("codex app-server process exited");
        codex_mark_stopped();
    });

    log::info!("codex app-server started (stdio mode)");
    Ok(true)
}

/// Send a JSON-RPC message to the codex app-server's stdin.
#[tauri::command]
async fn codex_rpc_send(message: String) -> Result<(), String> {
    let mut guard = codex_stdin_lock().lock().await;
    let stdin = guard.as_mut()
        .ok_or_else(|| "codex app-server not running".to_string())?;

    let data = format!("{}\n", message);
    stdin.write_all(data.as_bytes()).await
        .map_err(|e| format!("Failed to write to codex stdin: {}", e))?;
    stdin.flush().await
        .map_err(|e| format!("Failed to flush codex stdin: {}", e))?;
    Ok(())
}

/// Check if the codex app-server is running.
#[tauri::command]
fn get_codex_app_server_info() -> bool {
    CODEX_RUNNING.load(Ordering::SeqCst)
}

// ── Tauri IPC Commands ────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum StreamEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { exit_code: i32 },
    Error { message: String },
}

#[tauri::command]
async fn execute_command(
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
) -> Result<ExecResponse, String> {
    let mut cmd = platform::build_command(&command, cwd.as_deref(), env.as_ref());
    let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30000));
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("Process error: {}", e)),
        Err(_) => return Err(format!("Command timed out after {}ms", timeout_ms.unwrap_or(30000))),
    };
    const MAX_OUTPUT: usize = 1024 * 1024;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout_str = if stdout.len() > MAX_OUTPUT {
        format!("{}... [truncated, {} total bytes]", &stdout[..MAX_OUTPUT], stdout.len())
    } else {
        stdout.to_string()
    };
    let stderr_str = if stderr.len() > MAX_OUTPUT {
        format!("{}... [truncated, {} total bytes]", &stderr[..MAX_OUTPUT], stderr.len())
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
async fn execute_stream_command(
    command: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    on_event: tauri::ipc::Channel<StreamEvent>,
) -> Result<(), String> {
    let mut cmd = platform::build_command(&command, cwd.as_deref(), env.as_ref());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30000));
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let result = tokio::time::timeout(timeout, async {
        let mut stdout_buf = [0u8; 4096];
        let mut stderr_buf = [0u8; 4096];
        let mut stdout_done = false;
        let mut stderr_done = false;

        loop {
            if stdout_done && stderr_done {
                break;
            }
            tokio::select! {
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
    }).await;

    match result {
        Ok(Ok(status)) => {
            let _ = on_event.send(StreamEvent::Exit { exit_code: status.code().unwrap_or(-1) });
        }
        Ok(Err(e)) => {
            let _ = on_event.send(StreamEvent::Error { message: format!("Process error: {}", e) });
        }
        Err(_) => {
            platform::graceful_kill(&mut child).await;
            let _ = on_event.send(StreamEvent::Error { message: format!("Command timed out after {}ms", timeout_ms.unwrap_or(30000)) });
        }
    }
    Ok(())
}

/// Start a local HTTP server for dev mode auth callbacks.
/// This replaces deep links which don't work in `tauri dev` on macOS.
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
    log::info!("Dev auth callback server listening on http://localhost:{}", port);

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

            let token = parsed.query_pairs()
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.to_string());
            let origin = parsed.query_pairs()
                .find(|(k, _)| k == "origin")
                .map(|(_, v)| v.to_string());

            match token {
                Some(ref t) if is_valid_token_format(t) => {
                    let origin = origin
                        .filter(|o| validate_origin(o))
                        .unwrap_or_else(|| "http://localhost:3000".to_string());

                    let encoded_token: String =
                        url::form_urlencoded::byte_serialize(t.as_bytes()).collect();
                    let callback_url = format!("{}/desktop-callback?token={}", origin, encoded_token);

                    log::info!("Dev auth: navigating to callback (token: {}...)", &t[..8.min(t.len())]);

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
                    log::warn!("Dev auth: invalid or missing token");
                    let response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            }
        });
    }
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_dev_auth_port, get_cmd_server_info, execute_command, execute_stream_command, start_codex_app_server, codex_rpc_send, get_codex_app_server_info, set_convex_auth])
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
            // Start dev auth callback server when running in debug mode
            // (deep links don't work with `tauri dev` on macOS)
            #[cfg(debug_assertions)]
            {
                let dev_handle = app.handle().clone();
                tauri::async_runtime::spawn(start_dev_auth_server(dev_handle));
            }

            // Start command execution server (always, for local terminal commands)
            tauri::async_runtime::spawn(start_cmd_server());

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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                codex_kill();
            }
        });
}
