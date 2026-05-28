use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use tauri::ipc::Channel;

use crate::platform;

const OUTPUT_BUFFER_MAX_BYTES: usize = 32 * 1024;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    reader_shutdown: Arc<std::sync::atomic::AtomicBool>,
    command_script: Option<PathBuf>,
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

#[derive(Serialize, Clone)]
pub struct PtyCreateResult {
    pub pid: Option<u32>,
    pub session_id: String,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn create(
        &mut self,
        session_id: String,
        command: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        on_data: Channel<String>,
    ) -> Result<PtyCreateResult, String> {
        if self.sessions.contains_key(&session_id) {
            return Err(format!("Session '{}' already exists", session_id));
        }

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let shell_config = platform::get_shell_config();
        let (mut cmd, command_script) = build_pty_command(&shell_config, &command)?;

        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }

        if let Some(ref env_map) = env {
            for (k, v) in env_map {
                cmd.env(k, v);
            }
        }

        let child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(e) => {
                cleanup_command_script(command_script.as_deref());
                return Err(format!("Failed to spawn command: {}", e));
            }
        };

        let pid = child.process_id();

        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(e) => {
                cleanup_command_script(command_script.as_deref());
                return Err(format!("Failed to clone PTY reader: {}", e));
            }
        };

        let shutdown_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let shutdown_clone = shutdown_flag.clone();
        let command_script_cleanup = command_script.clone();

        let session_id_clone = session_id.clone();
        thread::spawn(move || {
            pty_reader_thread(reader, on_data, shutdown_clone, session_id_clone);
            cleanup_command_script(command_script_cleanup.as_deref());
        });

        // Take the writer ONCE at creation time and cache it. Calling
        // take_writer() on every send_input duplicates the fd each time,
        // which was causing sendInput failures and eventual resource issues.
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(e) => {
                cleanup_command_script(command_script.as_deref());
                return Err(format!("Failed to get PTY writer: {}", e));
            }
        };

        let session = PtySession {
            master: pair.master,
            child,
            writer,
            reader_shutdown: shutdown_flag,
            command_script,
        };

        let result = PtyCreateResult {
            pid,
            session_id: session_id.clone(),
        };

        self.sessions.insert(session_id, session);

        Ok(result)
    }

    pub fn send_input(&mut self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| session_not_found_err(session_id))?;

        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;

        session
            .writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY writer: {}", e))?;

        Ok(())
    }

    pub fn resize(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| session_not_found_err(session_id))?;

        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))?;

        Ok(())
    }

    pub fn kill(&mut self, session_id: &str) -> Result<(), String> {
        let mut session = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| session_not_found_err(session_id))?;

        session
            .reader_shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);

        if let Err(e) = session.child.kill() {
            cleanup_command_script(session.command_script.as_deref());
            return Err(format!("Failed to kill PTY child: {}", e));
        }

        let _ = session.child.wait();
        cleanup_command_script(session.command_script.as_deref());

        Ok(())
    }

    pub fn stop_all(&mut self) {
        let session_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in session_ids {
            if let Err(e) = self.kill(&id) {
                log::warn!("Failed to kill PTY session '{}': {}", id, e);
            }
        }
    }
}

fn build_pty_command(
    shell_config: &platform::ShellConfig,
    command: &str,
) -> Result<(CommandBuilder, Option<PathBuf>), String> {
    if command.is_empty() {
        return Ok((CommandBuilder::new(&shell_config.shell), None));
    }

    #[cfg(windows)]
    if shell_config.is_cmd {
        // portable-pty does not expose raw_arg, so keep the command body out of
        // its MSVCRT-style argument quoting path when falling back to cmd.exe.
        let script = write_cmd_script(command)?;
        let mut cmd = CommandBuilder::new(&shell_config.shell);
        cmd.arg(shell_config.flag);
        cmd.arg("call");
        cmd.arg(script.as_os_str());
        return Ok((cmd, Some(script)));
    }

    let mut cmd = CommandBuilder::new(&shell_config.shell);
    cmd.arg(shell_config.flag);
    cmd.arg(command);
    Ok((cmd, None))
}

#[cfg(windows)]
fn write_cmd_script(command: &str) -> Result<PathBuf, String> {
    use std::fs::OpenOptions;
    use uuid::Uuid;

    for _ in 0..8 {
        let path = std::env::temp_dir().join(format!("hackerai-pty-{}.cmd", Uuid::new_v4()));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(format!(
                    "Failed to create temporary cmd script '{}': {}",
                    path.display(),
                    err
                ));
            }
        };

        file.write_all(b"@echo off\r\n")
            .and_then(|_| file.write_all(command.as_bytes()))
            .and_then(|_| file.write_all(b"\r\n"))
            .map_err(|err| {
                format!(
                    "Failed to write temporary cmd script '{}': {}",
                    path.display(),
                    err
                )
            })?;

        return Ok(path);
    }

    Err("Failed to create a unique temporary cmd script".to_string())
}

fn cleanup_command_script(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

fn pty_reader_thread(
    mut reader: Box<dyn Read + Send>,
    on_data: Channel<String>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    session_id: String,
) {
    let mut buf = [0u8; 4096];
    let mut output_buffer = Vec::with_capacity(OUTPUT_BUFFER_MAX_BYTES);

    loop {
        if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF -- flush remaining buffer and send exit
                flush_buffer(&on_data, &mut output_buffer);
                send_exit(&on_data, 0, &session_id);
                break;
            }
            Ok(n) => {
                output_buffer.extend_from_slice(&buf[..n]);

                // For interactive PTY, flush immediately after every read to
                // minimize latency. The server's idle timer needs to see output
                // as soon as it arrives. Batching caused prompts to arrive late,
                // after the idle timer had already fired.
                if !output_buffer.is_empty() {
                    let chunk = String::from_utf8_lossy(&output_buffer).to_string();
                    if on_data.send(chunk).is_err() {
                        // IPC channel closed (window gone / subscription dropped):
                        // no point reading further — bail so the thread exits.
                        log::debug!(
                            "PTY reader channel closed for session '{}', exiting reader",
                            session_id
                        );
                        break;
                    }
                    output_buffer.clear();
                }
            }
            Err(e) => {
                log::warn!("PTY reader error for session '{}': {}", session_id, e);
                flush_buffer(&on_data, &mut output_buffer);
                send_exit(&on_data, -1, &session_id);
                break;
            }
        }
    }
}

fn session_not_found_err(id: &str) -> String {
    format!("Session '{}' not found", id)
}

fn flush_buffer(on_data: &Channel<String>, buf: &mut Vec<u8>) {
    if buf.is_empty() {
        return;
    }
    let chunk = String::from_utf8_lossy(buf).to_string();
    let _ = on_data.send(chunk);
    buf.clear();
}

fn send_exit(on_data: &Channel<String>, exit_code: i32, session_id: &str) {
    let msg = serde_json::json!({
        "type": "exit",
        "exitCode": exit_code,
        "sessionId": session_id,
    })
    .to_string();
    let _ = on_data.send(msg);
}
