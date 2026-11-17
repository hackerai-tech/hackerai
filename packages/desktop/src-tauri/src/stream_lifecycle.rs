//! Native ownership of streamed commands across page documents.
//!
//! A command belongs to the main-page generation that admitted it, captured
//! before asynchronous authorization. Committing a replacement document or
//! losing the Linux web process invalidates that generation and asks every
//! owner to stop and reap its tree. A new document's commands wait until that
//! cleanup resolves. Only the owner signals its process group, and only while
//! its child is unreaped, so a recycled PID is never targeted. Same-document
//! route changes do not commit a document and leave commands running.
//!
//! Admission fails closed: once any owner cannot confirm its tree stopped,
//! descendants may still be running, so no further streamed command starts in
//! this native process.

use std::collections::{HashMap, HashSet};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::update_safety::UpdateGate;

/// Bounds a new document's wait for the previous document's cleanup.
const PRIOR_CLEANUP_WAIT: Duration = Duration::from_secs(10);
/// Bounds reaping after the process group was signaled.
const REAP_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds an explicit cancellation's wait for its owner.
const CANCEL_WAIT: Duration = Duration::from_secs(15);

pub(crate) const PAGE_REPLACED: &str = "Desktop page was replaced before this command started";
pub(crate) const PRIOR_CLEANUP_UNRESOLVED: &str =
    "Desktop is still stopping commands from a previous page. Retry shortly.";
pub(crate) const STOP_UNCONFIRMED: &str = "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub(crate) enum StreamEvent {
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

/// The page generation current when a command request first reached native code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Admission(u64);

/// Resolves to whether the owner confirmed its process tree stopped.
pub(crate) type Cleanup = watch::Receiver<Option<bool>>;

struct Running {
    serial: u64,
    generation: u64,
    stop: watch::Sender<bool>,
    cleanup: Cleanup,
}

#[derive(Default)]
struct State {
    generation: u64,
    next_serial: u64,
    running: HashMap<String, Running>,
    // Keep cancellation until app exit, including IPCs that arrive before launch.
    canceled: HashSet<String>,
    // Set once and never cleared: an owner could not confirm its tree stopped.
    unconfirmed: bool,
}

pub(crate) struct StreamLifecycle {
    state: Mutex<State>,
    update_gate: &'static UpdateGate,
}

impl Default for StreamLifecycle {
    fn default() -> Self {
        Self::with_update_gate(&crate::update_safety::UPDATE_GATE)
    }
}

pub(crate) enum Launch {
    Canceled,
    Started(OwnedCommand),
}

/// The only handle allowed to signal or reap a launched command.
pub(crate) struct OwnedCommand {
    pub(crate) child: Child,
    stop: watch::Receiver<bool>,
    completion: Completion,
}

struct Completion {
    lifecycle: Arc<StreamLifecycle>,
    command_id: String,
    serial: u64,
    outcome: watch::Sender<Option<bool>>,
    confirmed: bool,
}

impl Drop for Completion {
    fn drop(&mut self) {
        {
            let mut state = self.lifecycle.state();
            if state
                .running
                .get(&self.command_id)
                .is_some_and(|running| running.serial == self.serial)
            {
                state.running.remove(&self.command_id);
            }
            // Fence admission under the same lock that releases the entry, so no
            // launch can observe the slot free without also seeing the fence.
            state.unconfirmed |= !self.confirmed;
        }
        if !self.confirmed {
            // Descendants may still be writing. Keep updates fenced, as an
            // unconfirmed explicit cancellation does.
            self.lifecycle.update_gate.block_for_unconfirmed_command();
        }
        // Publish after removal so a waiting launch never observes this entry again.
        self.outcome.send_replace(Some(self.confirmed));
    }
}

impl StreamLifecycle {
    /// Tests pass their own gate so an injected unknown outcome cannot fence
    /// the process-wide updater for unrelated tests.
    pub(crate) fn with_update_gate(update_gate: &'static UpdateGate) -> Self {
        Self {
            state: Mutex::default(),
            update_gate,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Release builds abort on panic, so a poisoned lock only occurs in tests.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn fence_unconfirmed(&self) {
        self.state().unconfirmed = true;
        self.update_gate.block_for_unconfirmed_command();
    }

    /// Capture before any asynchronous work, such as authorization redemption.
    pub(crate) fn admit(&self) -> Admission {
        Admission(self.state().generation)
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state().generation
    }

    /// The admitting document is gone: fence its pending launches and ask every
    /// running owner to stop. Never blocks; callers may await the cleanups.
    pub(crate) fn invalidate(&self) -> (u64, Vec<Cleanup>) {
        let mut state = self.state();
        state.generation += 1;
        let current = state.generation;
        let cleanups = state
            .running
            .values()
            .filter(|running| running.generation < current)
            .map(|running| {
                running.stop.send_replace(true);
                running.cleanup.clone()
            })
            .collect();
        (current, cleanups)
    }

    /// Spawn only for the current generation, after earlier generations' cleanup
    /// resolves. Spawn and registration are atomic with respect to cancellation.
    pub(crate) async fn launch(
        self: &Arc<Self>,
        admission: Admission,
        command_id: &str,
        cmd: &mut Command,
    ) -> Result<Launch, String> {
        let deadline = tokio::time::Instant::now() + PRIOR_CLEANUP_WAIT;
        loop {
            let pending: Vec<Cleanup> = {
                let mut state = self.state();
                if state.canceled.contains(command_id) {
                    return Ok(Launch::Canceled);
                }
                if admission.0 != state.generation {
                    return Err(PAGE_REPLACED.to_string());
                }
                if state.unconfirmed {
                    return Err(STOP_UNCONFIRMED.to_string());
                }
                let current = state.generation;
                let pending: Vec<Cleanup> = state
                    .running
                    .values()
                    .filter(|running| running.generation < current)
                    .map(|running| running.cleanup.clone())
                    .collect();
                if pending.is_empty() {
                    if state.running.contains_key(command_id) {
                        return Err("Command is already running".to_string());
                    }
                    let child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
                    state.next_serial += 1;
                    let serial = state.next_serial;
                    let (stop, stop_requested) = watch::channel(false);
                    let (outcome, cleanup) = watch::channel(None);
                    state.running.insert(
                        command_id.to_string(),
                        Running {
                            serial,
                            generation: current,
                            stop,
                            cleanup,
                        },
                    );
                    return Ok(Launch::Started(OwnedCommand {
                        child,
                        stop: stop_requested,
                        completion: Completion {
                            lifecycle: self.clone(),
                            command_id: command_id.to_string(),
                            serial,
                            outcome,
                            confirmed: false,
                        },
                    }));
                }
                pending
            };
            match tokio::time::timeout_at(deadline, resolved(pending)).await {
                // Still stopping: the entries remain, so later launches wait too.
                Err(_) => return Err(PRIOR_CLEANUP_UNRESOLVED.to_string()),
                // The failed owner already set the durable fence.
                Ok(false) => return Err(STOP_UNCONFIRMED.to_string()),
                Ok(true) => {}
            }
        }
    }

    /// Record a tombstone and ask the owner, if running, to stop. True only when
    /// no process is running or its owner confirmed the tree stopped.
    pub(crate) async fn cancel(&self, command_id: &str) -> bool {
        let cleanup = {
            let mut state = self.state();
            state.canceled.insert(command_id.to_string());
            state.running.get(command_id).map(|running| {
                running.stop.send_replace(true);
                running.cleanup.clone()
            })
        };
        // Either it already exited, or its future launch is now fenced. A
        // concurrent launch cannot pass the fence before registering itself.
        let Some(cleanup) = cleanup else {
            return true;
        };
        match tokio::time::timeout(CANCEL_WAIT, resolved(vec![cleanup])).await {
            Ok(confirmed) => confirmed,
            // An owner that has not answered is an unknown outcome.
            Err(_) => {
                self.fence_unconfirmed();
                false
            }
        }
    }
}

/// Wait for every cleanup; true only when each owner confirmed its tree stopped.
pub(crate) async fn resolved(cleanups: Vec<Cleanup>) -> bool {
    let mut confirmed = true;
    for mut cleanup in cleanups {
        confirmed &= match cleanup.wait_for(Option::is_some).await {
            Ok(outcome) => (*outcome).unwrap_or(false),
            Err(_) => false,
        };
    }
    confirmed
}

/// For the app-exit callback, which runs outside the async runtime. Owners keep
/// running on runtime workers while this thread waits.
pub(crate) fn resolved_blocking(cleanups: &[Cleanup], deadline: Duration) -> bool {
    let until = std::time::Instant::now() + deadline;
    loop {
        if cleanups.iter().all(|cleanup| cleanup.borrow().is_some()) {
            return cleanups
                .iter()
                .all(|cleanup| *cleanup.borrow() == Some(true));
        }
        if std::time::Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

enum Ended {
    Exited(ExitStatus),
    ProcessError(std::io::Error),
    DeliveryFailed,
    StopRequested,
    TimedOut,
}

/// Stream output until exit, timeout, explicit stop or failed delivery, then
/// release the command's registration with its cleanup outcome.
pub(crate) async fn run(
    owned: OwnedCommand,
    input: Option<Vec<u8>>,
    timeout: Duration,
    on_event: &Channel<StreamEvent>,
) {
    let OwnedCommand {
        mut child,
        mut stop,
        mut completion,
    } = owned;
    let ended = {
        let streaming = stream_until_exit(&mut child, input, on_event);
        tokio::select! {
            biased;
            _ = stop_requested(&mut stop) => Ended::StopRequested,
            result = tokio::time::timeout(timeout, streaming) => {
                result.unwrap_or(Ended::TimedOut)
            }
        }
    };
    completion.confirmed = match ended {
        Ended::Exited(status) => {
            let _ = on_event.send(StreamEvent::Exit {
                exit_code: status.code().unwrap_or(-1),
            });
            true
        }
        Ended::ProcessError(e) => {
            let confirmed = crate::platform::graceful_kill(&mut child).await;
            let _ = on_event.send(StreamEvent::Error {
                message: format!("Process error: {}", e),
            });
            confirmed
        }
        Ended::TimedOut => {
            let confirmed = crate::platform::graceful_kill(&mut child).await;
            let _ = on_event.send(StreamEvent::Error {
                message: format!("Command timed out after {}ms", timeout.as_millis()),
            });
            confirmed
        }
        Ended::StopRequested => {
            let (confirmed, status) = terminate_owned(&mut child).await;
            let _ = on_event.send(match status {
                Some(status) => StreamEvent::Exit {
                    exit_code: status.code().unwrap_or(-1),
                },
                None => StreamEvent::Error {
                    message: "Desktop could not confirm the command stopped".to_string(),
                },
            });
            confirmed
        }
        // The receiver is gone: stop producing output nobody can deliver.
        Ended::DeliveryFailed => terminate_owned(&mut child).await.0,
    };
}

async fn stop_requested(stop: &mut watch::Receiver<bool>) {
    if stop.wait_for(|requested| *requested).await.is_err() {
        // The registration outlives its owner, so this is unreachable; never
        // treat a closed signal as a stop request.
        std::future::pending::<()>().await;
    }
}

async fn stream_until_exit(
    child: &mut Child,
    input: Option<Vec<u8>>,
    on_event: &Channel<StreamEvent>,
) -> Ended {
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Ended::ProcessError(std::io::Error::other("Failed to capture output"));
    };
    let mut write_input = Box::pin(crate::command_stdin::write(child.stdin.take(), input));
    let mut stdout_buf = [0u8; 4096];
    let mut stderr_buf = [0u8; 4096];
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut input_done = false;

    while !(stdout_done && stderr_done && input_done) {
        tokio::select! {
            result = &mut write_input, if !input_done => {
                input_done = true;
                if let Err(e) = result {
                    return Ended::ProcessError(e);
                }
            }
            result = stdout.read(&mut stdout_buf), if !stdout_done => match result {
                Ok(0) | Err(_) => stdout_done = true,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&stdout_buf[..n]).to_string();
                    if on_event.send(StreamEvent::Stdout { data }).is_err() {
                        return Ended::DeliveryFailed;
                    }
                }
            },
            result = stderr.read(&mut stderr_buf), if !stderr_done => match result {
                Ok(0) | Err(_) => stderr_done = true,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&stderr_buf[..n]).to_string();
                    if on_event.send(StreamEvent::Stderr { data }).is_err() {
                        return Ended::DeliveryFailed;
                    }
                }
            },
        }
    }
    match child.wait().await {
        Ok(status) => Ended::Exited(status),
        Err(e) => Ended::ProcessError(e),
    }
}

/// Stop the owned tree while reaping its leader concurrently: an unreaped
/// leader keeps its process group alive.
async fn terminate_owned(child: &mut Child) -> (bool, Option<ExitStatus>) {
    let Some(pid) = child.id() else {
        // Already reaped by this owner; no live PID remains to signal.
        return (true, child.try_wait().ok().flatten());
    };
    let (stopped, waited) = tokio::join!(
        crate::platform::cancel_process_tree(pid),
        tokio::time::timeout(REAP_TIMEOUT, child.wait())
    );
    let status = waited.ok().and_then(Result::ok);
    (stopped && status.is_some(), status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stream_lifecycle_cancel_before_launch_prevents_a_native_process() {
        let lifecycle = Arc::new(StreamLifecycle::default());
        assert!(lifecycle.cancel("stopped").await);
        let mut cmd = crate::platform::build_command("echo should-not-run", None, None);
        let page = lifecycle.admit();
        assert!(matches!(
            lifecycle.launch(page, "stopped", &mut cmd).await,
            Ok(Launch::Canceled)
        ));
        // A duplicate late delivery must remain canceled as well.
        assert!(matches!(
            lifecycle.launch(page, "stopped", &mut cmd).await,
            Ok(Launch::Canceled)
        ));
        let mut replacement = crate::platform::build_command("echo replacement", None, None);
        let Ok(Launch::Started(owned)) = lifecycle
            .launch(page, "replacement", &mut replacement)
            .await
        else {
            panic!("an uncanceled command must launch");
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        });
        run(owned, None, Duration::from_secs(30), &channel).await;
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"exit","exitCode":0}"#)
        );
        assert!(lifecycle.state().running.is_empty());
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use crate::platform;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hackerai-stream-lifecycle-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn quoted(path: &Path) -> String {
        format!("'{}'", path.display())
    }

    fn lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    async fn wait_for_file(path: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(content) = std::fs::read_to_string(path) {
                if content.ends_with('\n') {
                    return content.trim().to_string();
                }
            }
            assert!(Instant::now() < deadline, "command never became ready");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn group_alive(pgid: u32) -> bool {
        let result = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn process_alive(pid: libc::pid_t) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn collecting_channel() -> (Channel<StreamEvent>, Arc<Mutex<Vec<String>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        });
        (channel, events)
    }

    fn started(launch: Result<Launch, String>) -> OwnedCommand {
        match launch.expect("launch should be admitted") {
            Launch::Started(owned) => owned,
            Launch::Canceled => panic!("launch was unexpectedly canceled"),
        }
    }

    /// A long-running tree: a backgrounded descendant whose PID is recorded,
    /// then a marker line once everything is running.
    fn long_tree(scratch: &Scratch, marker: &str) -> String {
        format!(
            "sleep 60 & echo $! > {}; printf '{marker}\\n' >> {}; wait",
            quoted(&scratch.path("descendant")),
            quoted(&scratch.path("runs")),
        )
    }

    #[tokio::test]
    async fn stream_lifecycle_unconfirmed_owner_outcome_fences_waiting_and_later_launches() {
        let scratch = Scratch::new();
        // A private gate: this test's unknown outcome must not fence the
        // process-wide updater used by other tests.
        let gate: &'static UpdateGate = Box::leak(Box::new(UpdateGate::default()));
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(gate));
        let mut cmd = platform::build_command(&long_tree(&scratch, "old"), None, None);
        let owned = started(lifecycle.launch(lifecycle.admit(), "old", &mut cmd).await);
        let leader = owned.child.id().unwrap();
        let descendant: libc::pid_t = wait_for_file(&scratch.path("descendant"))
            .await
            .parse()
            .unwrap();
        wait_for_file(&scratch.path("runs")).await;

        lifecycle.invalidate();
        let successor = tokio::spawn({
            let lifecycle = lifecycle.clone();
            let admission = lifecycle.admit();
            let command = format!("printf 'successor\\n' >> {}", quoted(&scratch.path("runs")));
            async move {
                let mut cmd = platform::build_command(&command, None, None);
                lifecycle
                    .launch(admission, "successor", &mut cmd)
                    .await
                    .err()
            }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !successor.is_finished(),
            "the next page must wait for the previous owner"
        );

        // Stop the test-owned tree exactly, then release ownership as an owner
        // that could not confirm its cleanup would.
        let OwnedCommand {
            mut child,
            completion,
            ..
        } = owned;
        assert!(terminate_owned(&mut child).await.0);
        assert!(!group_alive(leader));
        assert!(!process_alive(descendant));
        drop(completion);

        assert_eq!(successor.await.unwrap().as_deref(), Some(STOP_UNCONFIRMED));
        // The fence is durable: a later page's fresh admission still fails.
        let mut later = platform::build_command(
            &format!("printf 'later\\n' >> {}", quoted(&scratch.path("runs"))),
            None,
            None,
        );
        assert_eq!(
            lifecycle
                .launch(lifecycle.admit(), "later", &mut later)
                .await
                .err()
                .as_deref(),
            Some(STOP_UNCONFIRMED)
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(lines(&scratch.path("runs")), ["old"]);
        assert!(gate.install().is_err(), "updates must stay fenced too");
    }

    #[tokio::test]
    async fn stream_lifecycle_document_replacement_stops_owned_tree_and_fresh_page_runs_once() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        let old_page = lifecycle.admit();
        let mut cmd = platform::build_command(&long_tree(&scratch, "old"), None, None);
        let owned = started(lifecycle.launch(old_page, "old-command", &mut cmd).await);
        let leader = owned.child.id().unwrap();
        let (channel, _) = collecting_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(120), &channel).await });
        let descendant: libc::pid_t = wait_for_file(&scratch.path("descendant"))
            .await
            .parse()
            .unwrap();
        wait_for_file(&scratch.path("runs")).await;

        let (_, cleanups) = lifecycle.invalidate();
        assert_eq!(cleanups.len(), 1);
        let confirmed = tokio::time::timeout(Duration::from_secs(10), resolved(cleanups))
            .await
            .expect("document cleanup must resolve");
        assert!(confirmed);
        owner.await.unwrap();
        assert!(!group_alive(leader));
        assert!(!process_alive(descendant));

        // A request the old document admitted cannot launch after replacement.
        let mut late = platform::build_command(
            &format!("printf 'late\\n' >> {}", quoted(&scratch.path("runs"))),
            None,
            None,
        );
        assert_eq!(
            lifecycle
                .launch(old_page, "late-command", &mut late)
                .await
                .err()
                .as_deref(),
            Some(PAGE_REPLACED)
        );

        // The replacement document's first command runs exactly once.
        let fresh_page = lifecycle.admit();
        let mut fresh = platform::build_command(
            &format!("printf 'fresh\\n' >> {}", quoted(&scratch.path("runs"))),
            None,
            None,
        );
        let owned = started(
            lifecycle
                .launch(fresh_page, "fresh-command", &mut fresh)
                .await,
        );
        let (channel, events) = collecting_channel();
        run(owned, None, Duration::from_secs(30), &channel).await;
        assert_eq!(lines(&scratch.path("runs")), ["old", "fresh"]);
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"exit","exitCode":0}"#)
        );
    }

    #[tokio::test]
    async fn stream_lifecycle_pending_authorization_from_replaced_page_never_spawns() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        // Captured when the request arrives, before authorization redemption.
        let admission = lifecycle.admit();
        // The page commits a replacement while redemption is still pending.
        lifecycle.invalidate();
        let command = format!("printf 'ran\\n' >> {}", quoted(&scratch.path("runs")));
        let mut cmd = platform::build_command(&command, None, None);
        assert_eq!(
            lifecycle
                .launch(admission, "pending", &mut cmd)
                .await
                .err()
                .as_deref(),
            Some(PAGE_REPLACED)
        );
        // Give a mistakenly spawned shell time to write before checking.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!scratch.path("runs").exists());
        assert!(lifecycle.state().running.is_empty());

        // The replacement document can run the same work under its own admission.
        let mut cmd = platform::build_command(&command, None, None);
        let owned = started(lifecycle.launch(lifecycle.admit(), "retry", &mut cmd).await);
        let (channel, _) = collecting_channel();
        run(owned, None, Duration::from_secs(30), &channel).await;
        assert_eq!(lines(&scratch.path("runs")), ["ran"]);
    }

    #[tokio::test]
    async fn stream_lifecycle_new_page_waits_for_previous_cleanup_before_spawning() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        // Ignoring SIGTERM forces SIGKILL escalation, so cleanup takes a while.
        let stubborn = format!(
            "trap '' TERM; printf 'ready\\n' > {}; while :; do sleep 0.1; done",
            quoted(&scratch.path("ready"))
        );
        let mut cmd = platform::build_command(&stubborn, None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "stubborn", &mut cmd)
                .await,
        );
        let leader = owned.child.id().unwrap();
        let (channel, _) = collecting_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(120), &channel).await });
        wait_for_file(&scratch.path("ready")).await;

        lifecycle.invalidate();
        let mut fresh = platform::build_command("true", None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "fresh", &mut fresh)
                .await,
        );
        // The new command could only spawn after the old tree was gone.
        assert!(!group_alive(leader));
        assert!(!lifecycle.state().running.contains_key("stubborn"));
        let (channel, _) = collecting_channel();
        run(owned, None, Duration::from_secs(30), &channel).await;
        owner.await.unwrap();
    }

    #[tokio::test]
    async fn stream_lifecycle_failed_output_delivery_terminates_and_reaps_owned_tree() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        let command = format!(
            "sleep 60 & echo $! > {}; echo output; wait",
            quoted(&scratch.path("descendant"))
        );
        let mut cmd = platform::build_command(&command, None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "undeliverable", &mut cmd)
                .await,
        );
        let leader = owned.child.id().unwrap();
        let attempts = Arc::new(Mutex::new(0usize));
        let counted = attempts.clone();
        let closed: Channel<StreamEvent> = Channel::new(move |_| {
            *counted.lock().unwrap() += 1;
            Err(std::io::Error::other("receiver closed").into())
        });
        tokio::time::timeout(
            Duration::from_secs(20),
            run(owned, None, Duration::from_secs(120), &closed),
        )
        .await
        .expect("failed delivery must stop the command");
        assert!(!group_alive(leader));
        // A noisy login profile can fail delivery before the descendant starts.
        if let Ok(descendant) = std::fs::read_to_string(scratch.path("descendant")) {
            assert!(!process_alive(descendant.trim().parse().unwrap()));
        }
        // No further output is attempted after the first failed delivery.
        assert_eq!(*attempts.lock().unwrap(), 1);
        assert!(lifecycle.state().running.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stream_lifecycle_app_exit_waits_for_owned_trees_to_stop() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        let mut cmd = platform::build_command(&long_tree(&scratch, "exit"), None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "at-exit", &mut cmd)
                .await,
        );
        let leader = owned.child.id().unwrap();
        let (channel, _) = collecting_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(120), &channel).await });
        let descendant: libc::pid_t = wait_for_file(&scratch.path("descendant"))
            .await
            .parse()
            .unwrap();

        // RunEvent::Exit runs on the event-loop thread, outside the runtime.
        let exiting = lifecycle.clone();
        let confirmed = tokio::task::spawn_blocking(move || {
            let (_, cleanups) = exiting.invalidate();
            resolved_blocking(&cleanups, Duration::from_secs(10))
        })
        .await
        .unwrap();
        assert!(confirmed);
        assert!(!group_alive(leader));
        assert!(!process_alive(descendant));
        owner.await.unwrap();
    }

    #[tokio::test]
    async fn stream_lifecycle_cancel_after_launch_stops_the_owned_process_group() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        let mut cmd = platform::build_command(&long_tree(&scratch, "running"), None, None);
        let page = lifecycle.admit();
        let owned = started(lifecycle.launch(page, "running", &mut cmd).await);
        let leader = owned.child.id().unwrap();
        let (channel, events) = collecting_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(120), &channel).await });
        let descendant: libc::pid_t = wait_for_file(&scratch.path("descendant"))
            .await
            .parse()
            .unwrap();
        wait_for_file(&scratch.path("runs")).await;

        assert!(lifecycle.cancel("running").await);
        owner.await.unwrap();
        assert!(!group_alive(leader));
        assert!(!process_alive(descendant));
        // Cancellation keeps the existing terminal event for a signaled shell.
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"exit","exitCode":-1}"#)
        );
        // Cancellation does not invalidate the page, and its tombstone remains.
        assert_eq!(lifecycle.admit(), page);
        assert!(matches!(
            lifecycle.launch(page, "running", &mut cmd).await,
            Ok(Launch::Canceled)
        ));
        assert_eq!(lines(&scratch.path("runs")), ["running"]);
    }

    #[tokio::test]
    async fn stream_lifecycle_group_signals_never_fall_back_to_a_stale_positive_pid() {
        // A recycled PID that now names an unrelated, non-leader process must
        // not be signaled through an owned-group termination.
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = unrelated.id().unwrap();
        assert!(
            !group_alive(pid),
            "the unrelated process must not lead a group"
        );
        assert!(platform::cancel_process_tree(pid).await);
        // Allow a mistakenly delivered signal to take effect before checking.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "an unrelated process with the stale PID was signaled"
        );
        unrelated.kill().await.unwrap();
    }
}
