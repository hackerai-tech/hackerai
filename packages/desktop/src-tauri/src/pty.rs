use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
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

        let shell = get_default_shell();

        let mut cmd = if command.is_empty() {
            CommandBuilder::new(&shell)
        } else {
            let mut c = CommandBuilder::new(&shell);
            let shell_flag = get_shell_exec_flag(&shell);
            c.arg(shell_flag);
            c.arg(&command);
            c
        };

        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }

        if let Some(ref env_map) = env {
            for (k, v) in env_map {
                cmd.env(k, v);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

        let pid = child.process_id();

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        let shutdown_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let shutdown_clone = shutdown_flag.clone();

        let session_id_clone = session_id.clone();
        thread::spawn(move || {
            pty_reader_thread(reader, on_data, shutdown_clone, session_id_clone);
        });

        // Take the writer ONCE at creation time and cache it. Calling
        // take_writer() on every send_input duplicates the fd each time,
        // which was causing sendInput failures and eventual resource issues.
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

        let session = PtySession {
            master: pair.master,
            child,
            writer,
            reader_shutdown: shutdown_flag,
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

        session
            .child
            .kill()
            .map_err(|e| format!("Failed to kill PTY child: {}", e))?;

        let _ = session.child.wait();

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

/// Get the default shell for the current platform.
fn get_default_shell() -> String {
    let config = platform::get_shell_config();
    config.shell
}

/// Get the flag used to execute a command string in the given shell.
fn get_shell_exec_flag(shell: &str) -> &'static str {
    if shell.contains("cmd") {
        "/C"
    } else {
        "-c"
    }
}
