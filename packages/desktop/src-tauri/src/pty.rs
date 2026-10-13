use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;

use crate::platform;

pub(crate) type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: PtyWriter,
    reader_shutdown: Arc<std::sync::atomic::AtomicBool>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

#[derive(Serialize, Clone)]
pub struct PtyCreateResult {
    pub pid: Option<u32>,
    pub session_id: String,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if sessions.contains_key(&session_id) {
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

        // Acquire fallible handles before spawning so setup failures cannot orphan a child.
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;
        let pid = child.process_id();
        let shutdown_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            reader_shutdown: shutdown_flag.clone(),
        };
        drop(pair.slave);
        let result = PtyCreateResult {
            pid,
            session_id: session_id.clone(),
        };

        sessions.insert(session_id.clone(), session);
        drop(sessions);
        let sessions = self.sessions.clone();
        thread::spawn(move || {
            supervise_pty(reader, child, on_data, shutdown_flag, session_id, sessions);
        });

        Ok(result)
    }

    pub(crate) fn input_writer(&self, session_id: &str) -> Result<PtyWriter, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| session_not_found_err(session_id))?;
        Ok(session.writer.clone())
    }

    /// Serialize input for one terminal without holding either manager lock.
    pub(crate) fn write_input(writer: PtyWriter, data: &str) -> Result<(), String> {
        let mut writer = writer.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;
        writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY writer: {}", e))?;
        Ok(())
    }

    pub fn resize(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        let session = sessions
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
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        // Natural completion may already have removed the session.
        let Some(session) = sessions.get_mut(session_id) else {
            return Ok(());
        };
        session
            .reader_shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // The supervisor owns the child, including kill escalation and reaping.
        Ok(())
    }

    pub fn stop_all(&mut self) {
        let session_ids: Vec<String> = match self.sessions.lock() {
            Ok(sessions) => sessions.keys().cloned().collect(),
            Err(_) => return,
        };
        for id in session_ids {
            if let Err(e) = self.kill(&id) {
                log::warn!("Failed to stop PTY session: {}", e);
            }
        }
        // App exit must give supervisors time to deliver cancellation before
        // the runtime terminates. Never wait indefinitely on inherited PTY handles.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if self
                .sessions
                .lock()
                .map(|sessions| sessions.is_empty())
                .unwrap_or(true)
            {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

fn supervise_pty(
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    on_data: Channel<String>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
) {
    let output_channel = on_data.clone();
    // Serialize the terminal event with output so a timed-out reader cannot
    // deliver late data after exit (including after reuse of the session ID).
    let output_closed = Arc::new(Mutex::new(false));
    let reader_output_closed = output_closed.clone();
    let reader_shutdown = shutdown.clone();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            if reader_shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let closed = reader_output_closed
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if *closed {
                        break;
                    }
                    if output_channel.send(chunk).is_err() {
                        reader_shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    // Unix PTYs can report EIO instead of EOF after the slave closes.
                    #[cfg(unix)]
                    if e.raw_os_error() == Some(libc::EIO) {
                        break;
                    }
                    log::warn!("PTY reader failed: {}", e.kind());
                    reader_shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
                    break;
                }
            }
        }
    });
    // Keep the child owner responsive while the reader waits for output.
    // Child::kill escalates ignored SIGHUP on Unix; clone_killer does not.
    let exit_code = loop {
        if shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = child.kill();
            break child
                .wait()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(-1);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.exit_code() as i32,
            Ok(None) => thread::sleep(std::time::Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break -1;
            }
        }
    };
    // Release the master/writer before draining: ConPTY keeps its output
    // pipe open until the pseudoconsole closes. Drop outside the map lock.
    let completed = if let Ok(mut sessions) = sessions.lock() {
        if sessions
            .get(&session_id)
            .is_some_and(|session| Arc::ptr_eq(&session.reader_shutdown, &shutdown))
        {
            sessions.remove(&session_id)
        } else {
            None
        }
    } else {
        None
    };
    drop(completed);
    // Descendants may retain slave handles even after the owned child exits.
    // Drain available output, but never let that delay the terminal event forever.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !reader_thread.is_finished() && std::time::Instant::now() < deadline {
        thread::sleep(std::time::Duration::from_millis(10));
    }
    shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
    if reader_thread.is_finished() {
        let _ = reader_thread.join();
    }
    let mut closed = output_closed.lock().unwrap_or_else(|e| e.into_inner());
    *closed = true;
    send_exit(&on_data, exit_code, &session_id);
}

fn session_not_found_err(id: &str) -> String {
    format!("Session '{}' not found", id)
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, Receiver};
    use std::time::{Duration, Instant};

    fn channel() -> (Channel<String>, Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let data: String = serde_json::from_str(&json).unwrap();
                let _ = tx.send(data);
            }
            Ok(())
        });
        (channel, rx)
    }

    fn wait_for_exit(rx: &Receiver<String>) -> (String, i64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        loop {
            let data = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) {
                if value["type"] == "exit" {
                    return (output, value["exitCode"].as_i64().unwrap());
                }
            }
            output.push_str(&data);
        }
    }

    #[test]
    fn reports_real_exit_after_output_and_releases_completed_sessions() {
        let mut manager = PtyManager::new();
        for code in [0, 7] {
            let (channel, rx) = channel();
            manager
                .create(
                    "completion".into(),
                    format!("printf audit-output; exit {code}"),
                    80,
                    24,
                    None,
                    None,
                    channel,
                )
                .unwrap();
            let (output, exit_code) = wait_for_exit(&rx);
            assert_eq!(output, "audit-output");
            assert_eq!(exit_code, code);
            assert!(manager.sessions.lock().unwrap().is_empty());
            // Cleanup after natural completion is idempotent.
            manager.kill("completion").unwrap();
        }
    }

    #[test]
    fn killing_a_running_child_reaps_and_removes_it() {
        let (channel, rx) = channel();
        let mut manager = PtyManager::new();
        manager
            .create(
                "cancel".into(),
                "exec sleep 30".into(),
                80,
                24,
                None,
                None,
                channel,
            )
            .unwrap();
        manager.kill("cancel").unwrap();
        let (_, exit_code) = wait_for_exit(&rx);
        assert_ne!(exit_code, 0);
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn cancellation_escalates_when_child_ignores_hangup() {
        let (channel, rx) = channel();
        let mut manager = PtyManager::new();
        manager
            .create(
                "ignore-hup".into(),
                "trap '' HUP; printf ready; exec sleep 30".into(),
                80,
                24,
                None,
                None,
                channel,
            )
            .unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "ready");
        manager.kill("ignore-hup").unwrap();
        let (_, exit_code) = wait_for_exit(&rx);
        assert_ne!(exit_code, 0);
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn blocked_input_does_not_prevent_cancellation_or_cleanup() {
        struct BlockedWriter {
            entered: mpsc::Sender<()>,
            release: Receiver<()>,
        }
        impl Write for BlockedWriter {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (channel, rx) = channel();
        let mut manager = PtyManager::new();
        manager
            .create(
                "blocked-input".into(),
                "exec sleep 30".into(),
                80,
                24,
                None,
                None,
                channel,
            )
            .unwrap();
        let (entered, writing) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        manager
            .sessions
            .lock()
            .unwrap()
            .get_mut("blocked-input")
            .unwrap()
            .writer = Arc::new(Mutex::new(Box::new(BlockedWriter {
            entered,
            release: blocked,
        })));
        let writer = manager.input_writer("blocked-input").unwrap();
        let write = thread::spawn(move || PtyManager::write_input(writer, "input"));
        writing.recv_timeout(Duration::from_secs(1)).unwrap();
        manager.kill("blocked-input").unwrap();
        let (_, exit_code) = wait_for_exit(&rx);
        assert_ne!(exit_code, 0);
        assert!(manager.sessions.lock().unwrap().is_empty());
        release.send(()).unwrap();
        write.join().unwrap().unwrap();
    }

    #[test]
    fn cancellation_unblocks_native_input_with_an_inherited_slave() {
        let (channel, rx) = channel();
        let mut manager = PtyManager::new();
        manager
            .create(
                "native-blocked-input".into(),
                // Disable canonical input consumption and keep a descendant's
                // slave handle open. Both processes ignore the initial SIGHUP.
                "stty -icanon -echo; trap '' HUP; sleep 5 & printf ready; wait".into(),
                80,
                24,
                None,
                None,
                channel,
            )
            .unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "ready");
        let writer = manager.input_writer("native-blocked-input").unwrap();
        let (finished, writing) = mpsc::channel();
        let write = thread::spawn(move || {
            let result = PtyManager::write_input(writer, &"x".repeat(4 * 1024 * 1024));
            finished.send(result).unwrap();
        });
        assert!(matches!(
            writing.recv_timeout(Duration::from_millis(200)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        manager.kill("native-blocked-input").unwrap();
        // This checks the actual blocked write, not just the terminal event or
        // removal from the session map. No mock writer is released by the test.
        assert!(writing
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err());
        write.join().unwrap();
        let (_, exit_code) = wait_for_exit(&rx);
        assert_ne!(exit_code, 0);
        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn blocked_reader_cannot_delay_exit_or_publish_late_output() {
        struct BlockedReader(Receiver<()>);
        impl Read for BlockedReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.0.recv().unwrap();
                buf[0] = b'L';
                Ok(1)
            }
        }
        #[derive(Debug)]
        struct ExitedChild;
        impl portable_pty::ChildKiller for ExitedChild {
            fn kill(&mut self) -> std::io::Result<()> {
                Ok(())
            }
            fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
                Box::new(Self)
            }
        }
        impl portable_pty::Child for ExitedChild {
            fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
                Ok(Some(portable_pty::ExitStatus::with_exit_code(7)))
            }
            fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
                Ok(portable_pty::ExitStatus::with_exit_code(7))
            }
            fn process_id(&self) -> Option<u32> {
                None
            }
        }
        let (release, blocked) = mpsc::channel();
        let (channel, rx) = channel();
        let supervisor = thread::spawn(move || {
            supervise_pty(
                Box::new(BlockedReader(blocked)),
                Box::new(ExitedChild),
                channel,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                "blocked".into(),
                Arc::new(Mutex::new(HashMap::new())),
            )
        });
        let started = Instant::now();
        let (output, exit_code) = wait_for_exit(&rx);
        assert_eq!(exit_code, 7);
        assert!(output.is_empty());
        assert!(started.elapsed() < Duration::from_secs(3));
        supervisor.join().unwrap();
        release.send(()).unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(1)).is_err(),
            "output arrived after exit"
        );
    }

    #[test]
    fn broken_output_channel_terminates_and_cleans_up_the_child() {
        let (tx, rx) = mpsc::channel();
        let channel = Channel::<String>::new(move |_| {
            let _ = tx.send(());
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "closed test channel").into())
        });
        let mut manager = PtyManager::new();
        manager
            .create(
                "closed".into(),
                "printf output; exec sleep 30".into(),
                80,
                24,
                None,
                None,
                channel,
            )
            .unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !manager.sessions.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "child was not cleaned up");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
