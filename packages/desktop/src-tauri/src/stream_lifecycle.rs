//! Native ownership of streamed commands across page documents.
//!
//! A command belongs to the main-page generation current when its IPC was
//! dispatched, captured synchronously before Tauri spawns the command and
//! before asynchronous authorization. Committing a replacement document or
//! losing the Linux web process invalidates that generation and asks every
//! in-flight owner to stop and reap its process group. A new document's
//! commands wait until that cleanup resolves. Only the owner signals its
//! group, and only while its shell is unreaped, so a recycled PID is never
//! targeted. Same-document route changes do not commit a document and leave
//! commands running.
//!
//! Scope: an owner is responsible for its in-flight command's process group.
//! A command that completes normally releases ownership even if it left an
//! intentional background job (for example `server > log 2>&1 &`); those jobs
//! keep running, as they always have. Descendants that leave the group
//! (`setsid`, `setpgid`, daemonizing) are outside any owner's reach, and abrupt
//! native death runs no cleanup at all.
//!
//! On Windows the owned tree is instead the command's private Job Object
//! (`windows_stream_job`), joined before the shell can run. Every stop
//! terminates that Job and confirms it empty, even after the shell itself
//! exited, and never signals a PID. A normal exit only closes the Job handle.
//!
//! Admission fails closed: once any owner cannot confirm its group stopped,
//! members may still be running, so no further streamed command starts in this
//! native process. The fence keeps the closed origin of the path that set it
//! first, for a stop request or an owner's own timeout which cleanup leg was
//! unconfirmed and, when that leg was only the Windows taskkill stop, how
//! taskkill failed, only for such a stop request which call path first asked
//! that owner to stop, for a stop request whose only unconfirmed leg was the
//! Unix tree stop that stop's final group probe class, and for a cancellation
//! wait timeout the matched owner's last published step, for an optional
//! diagnostic only; it never changes admission.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::num::NonZeroI32;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::platform::{GracefulKill, GroupProbe, LeaderWait, TaskkillFailure, TreeStopFailure};
use crate::stream_utf8::Utf8Stream;
use crate::update_safety::UpdateGate;

/// Bounds a new document's wait for the previous document's cleanup.
const PRIOR_CLEANUP_WAIT: Duration = Duration::from_secs(10);
/// Bounds reaping after the process group was signaled.
pub(crate) const REAP_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds an explicit cancellation's wait for its owner.
const CANCEL_WAIT: Duration = Duration::from_secs(15);

pub(crate) const PAGE_REPLACED: &str = "Desktop page was replaced before this command started";
pub(crate) const PRIOR_CLEANUP_UNRESOLVED: &str =
    "Desktop is still stopping commands from a previous page. Retry shortly.";
pub(crate) const STOP_UNCONFIRMED: &str = "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";
/// A created shell was never proven to run inside its tree, and its cleanup
/// confirmed it never ran.
const UNPROVEN_LAUNCH: &str =
    "Failed to spawn: Desktop could not start the command under its stop control";

// What an owner stops besides its shell: on Windows the command's private
// Job Object.
#[cfg(windows)]
use crate::windows_stream_job::{StreamJob as OwnedTree, Unproven};

/// Elsewhere the shell's own process group, reached through its PID only
/// while the shell is unreaped.
#[cfg(not(windows))]
struct OwnedTree;

/// Elsewhere a spawn either fails or starts its tracked tree.
#[cfg(not(windows))]
pub(crate) enum Unproven {}

#[cfg(not(windows))]
impl Unproven {
    fn may_have_run(&self) -> bool {
        match *self {}
    }

    async fn clean_up(self) -> bool {
        match self {}
    }
}

/// Why `spawn_owned` started no tracked command.
pub(crate) enum SpawnFailure {
    /// No process was created.
    NotStarted(String),
    /// A shell was created but not proven to run inside its tree; it must be
    /// cleaned up before the launch is rejected.
    // Only the Windows Job path constructs one.
    #[cfg_attr(not(windows), allow(dead_code))]
    Unproven(Unproven),
}

/// Spawn `cmd` with the tree its owner stops established before it can run.
#[cfg(not(windows))]
fn spawn_owned(cmd: &mut Command) -> Result<(Child, OwnedTree), SpawnFailure> {
    cmd.spawn()
        .map(|child| (child, OwnedTree))
        .map_err(|e| SpawnFailure::NotStarted(format!("Failed to spawn: {}", e)))
}

#[cfg(windows)]
fn spawn_owned(cmd: &mut Command) -> Result<(Child, OwnedTree), SpawnFailure> {
    crate::windows_stream_job::spawn(cmd)
}

/// The tree stop a stop request or failed delivery runs beside its leader
/// wait, or None once the Unix shell was reaped and no live PID remains.
#[cfg(not(windows))]
fn stop_tree(
    _tree: &OwnedTree,
    child: &Child,
) -> Option<impl Future<Output = Result<(), Option<TreeStopFailure>>>> {
    child
        .id()
        .map(crate::platform::cancel_process_tree_observed)
}

/// On Windows always the Job's stop, even after its shell was reaped, which
/// reports no closed taskkill failure.
#[cfg(windows)]
fn stop_tree<'a>(
    job: &'a OwnedTree,
    _child: &Child,
) -> Option<impl Future<Output = Result<(), Option<TreeStopFailure>>> + 'a> {
    Some(async move { job.terminate().await.then_some(()).ok_or(None) })
}

/// An owner's own cleanup after a timeout or process error.
#[cfg(not(windows))]
async fn graceful_kill_owned(child: &mut Child, _tree: &OwnedTree) -> GracefulKill {
    crate::platform::graceful_kill_observed(child).await
}

/// On Windows the Job's stop beside the same bounded leader wait, never
/// taskkill or a PID, so it reports no taskkill failure.
#[cfg(windows)]
async fn graceful_kill_owned(child: &mut Child, job: &OwnedTree) -> GracefulKill {
    let (tree_stopped, waited) = tokio::join!(
        job.terminate(),
        tokio::time::timeout(REAP_TIMEOUT, child.wait())
    );
    GracefulKill {
        tree_stopped,
        leader: match waited {
            Ok(Ok(_)) => LeaderWait::Reaped,
            Ok(Err(_)) => LeaderWait::Failed,
            Err(_) => LeaderWait::TimedOut,
        },
        taskkill: None,
    }
}

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

/// Which existing path first set the admission fence: a closed class of the
/// code path, never the process, its output or an OS error. It names the
/// owner's bounded final outcome or the cancellation wait, not why the tree
/// could not be confirmed stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FenceOrigin {
    OwnerTimeout,
    OwnerProcessError,
    OwnerStopRequested,
    OwnerDeliveryFailed,
    /// The owner was released before `run` recorded a final outcome.
    OwnerOutcomeMissing,
    CancelWaitTimeout,
}

/// Carried only beside an opted-in invocation's exact `STOP_UNCONFIRMED`
/// rejection, in that same rejection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FenceOriginReceipt {
    version: u8,
    origin: FenceOrigin,
}

/// Which checks of an explicit stop's or an owner timeout's existing cleanup
/// were unconfirmed: the tree termination, the bounded leader wait, or both.
/// The leader wait either reached its existing deadline or returned an error,
/// never its detail.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CleanupFailure {
    TreeUnconfirmed,
    LeaderWaitTimedOut,
    LeaderWaitFailed,
    TreeAndLeaderWaitTimedOut,
    TreeAndLeaderWaitFailed,
}

/// Carried only beside an `owner_stop_requested` or `owner_timeout` origin
/// receipt, in that same rejection, and only when separately opted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FenceCleanupReceipt {
    version: u8,
    failure: CleanupFailure,
}

/// How the Windows taskkill stop failed, for a stop request or an owner's own
/// timeout whose only unconfirmed check was that stop. Carried only beside its
/// `tree_unconfirmed` cleanup receipt, in that same rejection, and only when
/// separately opted in.
/// Version 2 is version 1 plus the closed root report, only for a nonzero
/// exit whose code the OS reported, and only when separately opted in again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FenceWindowsTaskkillReceipt {
    version: u8,
    outcome: TaskkillOutcome,
    // Present only for a nonzero exit whose code the OS reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<NonZeroI32>,
    // Present only in version 2.
    #[serde(skip_serializing_if = "Option::is_none")]
    root_report: Option<TaskkillRootReport>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum TaskkillOutcome {
    NonzeroExit,
    OutputError,
}

/// Whether taskkill's own output was exactly its report that the requested
/// root PID was not found, under its not-found exit code. Every other output,
/// language or code is `unclassified`, never a confirmation of anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum TaskkillRootReport {
    RequestedPidNotFound,
    Unclassified,
}

impl From<TaskkillFailure> for FenceWindowsTaskkillReceipt {
    /// The exact version 1 receipt, as before: a classified report keeps
    /// only its nonzero exit and code.
    fn from(failure: TaskkillFailure) -> Self {
        let (outcome, exit_code) = match failure {
            TaskkillFailure::NonzeroExit(code) => (TaskkillOutcome::NonzeroExit, code),
            TaskkillFailure::RequestedPidNotFound => (
                TaskkillOutcome::NonzeroExit,
                Some(crate::platform::TASKKILL_NOT_FOUND_EXIT),
            ),
            TaskkillFailure::OutputError => (TaskkillOutcome::OutputError, None),
        };
        Self {
            version: 1,
            outcome,
            exit_code,
            root_report: None,
        }
    }
}

impl FenceWindowsTaskkillReceipt {
    /// The version 2 receipt, only for a nonzero exit whose code the OS
    /// reported; otherwise None, so the caller keeps version 1.
    fn with_root_report(failure: TaskkillFailure) -> Option<Self> {
        let root_report = match failure {
            TaskkillFailure::RequestedPidNotFound => TaskkillRootReport::RequestedPidNotFound,
            TaskkillFailure::NonzeroExit(Some(_)) => TaskkillRootReport::Unclassified,
            TaskkillFailure::NonzeroExit(None) | TaskkillFailure::OutputError => return None,
        };
        Some(Self {
            version: 2,
            root_report: Some(root_report),
            ..Self::from(failure)
        })
    }
}

/// Which native call path first asked an owner to stop: the cancel IPC, a page
/// generation invalidation (a committed document or a lost web process), or
/// normal application exit. A closed class of the Rust caller, never a human
/// action, the process, a PID, a resource or a time. Each owner keeps only the
/// first; a later request still wakes it but never replaces that source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StopRequestSource {
    CancelIpc,
    DocumentInvalidation,
    ApplicationExit,
}

/// Carried only beside the version 2 taskkill receipt of the stop request that
/// recorded it, for its not-found exit code with either root report, in that
/// same rejection, and only when separately opted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FenceStopRequestSourceReceipt {
    version: u8,
    source: StopRequestSource,
}

/// The first source of the stop request whose only unconfirmed leg was the
/// Unix tree stop, beside that stop's final group probe class. Recorded with
/// that stop and read only on macOS, beside its `tree_unconfirmed` cleanup
/// receipt, in that same rejection, and only when separately opted in. Never
/// a timeout's, Windows' or Linux's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FenceDarwinStopReceipt {
    version: u8,
    source: StopRequestSource,
    group_probe: GroupProbe,
}

/// The receipt only on `macos`, only for a stop request's recorded first
/// source and tree-only leg's group probe class, and never beside a taskkill
/// failure. A timeout, a combined leg and every other origin never have one.
fn darwin_stop_receipt(fence: Fence, macos: bool) -> Option<FenceDarwinStopReceipt> {
    let tree_only_stop = fence.origin == FenceOrigin::OwnerStopRequested
        && fence.cleanup == Some(CleanupFailure::TreeUnconfirmed)
        && fence.taskkill.is_none();
    fence
        .group_probe
        .filter(|_| macos && tree_only_stop)
        .zip(fence.stop_source)
        .map(|(group_probe, source)| FenceDarwinStopReceipt {
            version: 1,
            source,
            group_probe,
        })
}

/// Only taskkill's not-found exit, classified `requested_pid_not_found` or
/// `unclassified`, exposes its stop request's source. Every other code, a
/// codeless exit and an output error never do.
fn exposes_stop_request_source(failure: TaskkillFailure) -> bool {
    use crate::platform::TASKKILL_NOT_FOUND_EXIT;
    match failure {
        TaskkillFailure::RequestedPidNotFound => true,
        TaskkillFailure::NonzeroExit(code) => code == Some(TASKKILL_NOT_FOUND_EXIT),
        TaskkillFailure::OutputError => false,
    }
}

/// The last step the owner matched by a timed-out cancellation wait had
/// published when that timeout set the fence, or `released` once that owner's
/// registration was gone. A closed class of the owner's own code path, never
/// the process, its output, a time or an OS error. It does not say whether any
/// process survived or that a step ran; only that its owner had not finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CancelWaitOwnerPhase {
    /// Registered, but `run` had not started.
    OwnerPending,
    /// Streaming output; the stop request was not yet observed.
    OwnerStreaming,
    /// Stopping after a stop request, with both concurrent checks outstanding.
    StopCleanupTreeAndLeaderPending,
    /// Stopping after a stop request; only the tree stop was outstanding.
    StopCleanupTreePending,
    /// Stopping after a stop request; only the leader wait was outstanding.
    StopCleanupLeaderPending,
    /// Stopping on its own after a timeout, process error or failed delivery.
    OwnerCleanup,
    /// Cleanup finished; delivering its final event, if any, before release.
    TerminalDelivery,
    /// The matched owner's registration had been released.
    Released,
}

/// Carried only beside a `cancel_wait_timeout` origin receipt, in that same
/// rejection, and only when separately opted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FenceCancelWaitOwnerPhaseReceipt {
    version: u8,
    phase: CancelWaitOwnerPhase,
}

/// An owner's last published step, written without a lock by its own `run`
/// and read only under the state lock. Best effort: a read reports whichever
/// step was published last, never an ordering with the process itself.
#[derive(Clone, Default)]
struct OwnerPhase(Arc<AtomicU8>);

impl OwnerPhase {
    // Zero, the initial value, is a registered owner whose `run` has not started.
    const PENDING: u8 = 0;
    const STREAMING: u8 = 1;
    const OWNER_CLEANUP: u8 = 2;
    const TERMINAL_DELIVERY: u8 = 3;
    // A stop request's cleanup, with one bit per check still outstanding.
    const STOP_CLEANUP: u8 = 0b1000;
    const TREE_PENDING: u8 = 0b0001;
    const LEADER_PENDING: u8 = 0b0010;

    fn publish(&self, step: u8) {
        self.0.store(step, Ordering::Relaxed);
    }

    /// Clear one stop-cleanup check's bit once that check has returned.
    fn finish_check(&self, check: u8) {
        self.0.fetch_and(!check, Ordering::Relaxed);
    }

    fn load(&self) -> CancelWaitOwnerPhase {
        use CancelWaitOwnerPhase::*;
        let step = self.0.load(Ordering::Relaxed);
        if step & Self::STOP_CLEANUP != 0 {
            return match (
                step & Self::TREE_PENDING != 0,
                step & Self::LEADER_PENDING != 0,
            ) {
                (true, true) => StopCleanupTreeAndLeaderPending,
                (true, false) => StopCleanupTreePending,
                (false, true) => StopCleanupLeaderPending,
                // Both checks returned; the owner is about to deliver.
                (false, false) => TerminalDelivery,
            };
        }
        match step {
            Self::PENDING => OwnerPending,
            Self::STREAMING => OwnerStreaming,
            Self::OWNER_CLEANUP => OwnerCleanup,
            _ => TerminalDelivery,
        }
    }
}

/// Await `check`, then clear its outstanding bit, if tracked. Each check is
/// constructed by the caller, so wrapping it changes neither its deadline nor
/// how it is polled.
async fn tracked<F: Future>(check: F, phase: Option<&OwnerPhase>, bit: u8) -> F::Output {
    let output = check.await;
    if let Some(phase) = phase {
        phase.finish_check(bit);
    }
    output
}

/// The admission fence's closed receipts, read together from its first outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FenceReceipts {
    pub(crate) origin: FenceOriginReceipt,
    pub(crate) cleanup: Option<FenceCleanupReceipt>,
    pub(crate) windows_taskkill: Option<FenceWindowsTaskkillReceipt>,
    /// The same failure's version 2 receipt, when it has one.
    pub(crate) windows_taskkill_root_report: Option<FenceWindowsTaskkillReceipt>,
    pub(crate) cancel_wait_owner_phase: Option<FenceCancelWaitOwnerPhaseReceipt>,
    /// The same stop request's first source, only beside its taskkill report
    /// of the not-found exit code, classified or `unclassified`.
    pub(crate) stop_request_source: Option<FenceStopRequestSourceReceipt>,
    /// On macOS only, a stop request's first source and its tree-only leg's
    /// final group probe class, never beside a taskkill failure.
    pub(crate) darwin_stop: Option<FenceDarwinStopReceipt>,
}

/// The first unconfirmed outcome. Its origin, cleanup leg, taskkill failure,
/// stop request source and owner phase are recorded together, so a later
/// outcome can never supply the detail of an earlier origin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fence {
    origin: FenceOrigin,
    // Only an explicit stop request or an owner's own timeout records the
    // leg that was unconfirmed.
    cleanup: Option<CleanupFailure>,
    // Only a stop request or an owner's own timeout whose sole unconfirmed
    // leg was the tree stop records how the Windows taskkill path failed.
    taskkill: Option<TaskkillFailure>,
    // Only a stop request records the first source its owner observed.
    stop_source: Option<StopRequestSource>,
    // Only a stop request whose sole unconfirmed leg was the tree stop
    // records the Unix final group probe class.
    group_probe: Option<GroupProbe>,
    // Only a cancellation wait timeout records its matched owner's phase.
    owner_phase: Option<CancelWaitOwnerPhase>,
}

impl Fence {
    /// `origin` with its unconfirmed cleanup leg, keeping the tree stop's
    /// taskkill failure only beside the tree-only leg, whose leader was reaped.
    fn with_cleanup(
        origin: FenceOrigin,
        failure: CleanupFailure,
        taskkill: Option<TaskkillFailure>,
    ) -> Self {
        Self {
            cleanup: Some(failure),
            taskkill: taskkill.filter(|_| failure == CleanupFailure::TreeUnconfirmed),
            ..origin.into()
        }
    }

    fn stop_requested(failure: CleanupFailure, taskkill: Option<TaskkillFailure>) -> Self {
        Self::with_cleanup(FenceOrigin::OwnerStopRequested, failure, taskkill)
    }

    /// A stop request's leg with its tree stop's reported failure: the
    /// taskkill failure as before, and the group probe class only beside the
    /// tree-only leg, whose leader was reaped.
    fn stop_requested_after(failure: CleanupFailure, tree: Option<TreeStopFailure>) -> Self {
        let fence = Self::stop_requested(failure, tree.and_then(TreeStopFailure::taskkill));
        Self {
            group_probe: tree
                .and_then(TreeStopFailure::group_probe)
                .filter(|_| failure == CleanupFailure::TreeUnconfirmed),
            ..fence
        }
    }

    /// An owner's own timeout: unconfirmed exactly when `graceful_kill` was,
    /// with the checks it left unconfirmed and, only for the tree-only leg,
    /// its own taskkill failure. Never a stop request source, which only an
    /// explicit stop records.
    fn owner_timeout(killed: GracefulKill) -> Option<Self> {
        cleanup_failure(killed.tree_stopped, killed.leader)
            .map(|failure| Self::with_cleanup(FenceOrigin::OwnerTimeout, failure, killed.taskkill))
    }

    /// The first source the owner observed with its stop request; every other
    /// origin is unchanged.
    fn requested_by(self, source: StopRequestSource) -> Self {
        Self {
            stop_source: (self.origin == FenceOrigin::OwnerStopRequested).then_some(source),
            ..self
        }
    }

    fn cancel_wait_timeout(phase: CancelWaitOwnerPhase) -> Self {
        Self {
            owner_phase: Some(phase),
            ..FenceOrigin::CancelWaitTimeout.into()
        }
    }
}

impl From<FenceOrigin> for Fence {
    fn from(origin: FenceOrigin) -> Self {
        Self {
            origin,
            cleanup: None,
            taskkill: None,
            stop_source: None,
            group_probe: None,
            owner_phase: None,
        }
    }
}

struct Running {
    serial: u64,
    generation: u64,
    // None until the first stop request, whose source it then keeps.
    stop: watch::Sender<Option<StopRequestSource>>,
    cleanup: Cleanup,
    phase: OwnerPhase,
}

impl Running {
    /// Called under the state lock. Every request notifies the owner, as
    /// before; only the first request's source is kept.
    fn request_stop(&self, source: StopRequestSource) {
        self.stop.send_modify(|first| {
            first.get_or_insert(source);
        });
    }
}

#[derive(Default)]
struct State {
    generation: u64,
    next_serial: u64,
    running: HashMap<String, Running>,
    // Keep cancellation until app exit, including IPCs that arrive before launch.
    canceled: HashSet<String>,
    // Set once and never cleared: an owner could not confirm its tree stopped.
    // The first outcome wins; admission only asks whether it is set.
    fence: Option<Fence>,
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
    tree: OwnedTree,
    stop: watch::Receiver<Option<StopRequestSource>>,
    completion: Completion,
    // Shared with this owner's registration; only this owner publishes to it.
    phase: OwnerPhase,
}

struct Completion {
    lifecycle: Arc<StreamLifecycle>,
    command_id: String,
    serial: u64,
    outcome: watch::Sender<Option<bool>>,
    /// None only once `run` confirmed the tree stopped. Until `run` records its
    /// final outcome, a released owner is unconfirmed with a missing outcome.
    unconfirmed: Option<Fence>,
}

impl Drop for Completion {
    fn drop(&mut self) {
        let confirmed = self.unconfirmed.is_none();
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
            if let Some(fence) = self.unconfirmed {
                state.fence.get_or_insert(fence);
            }
        }
        if !confirmed {
            // Descendants may still be writing. Keep updates fenced, as an
            // unconfirmed explicit cancellation does.
            self.lifecycle.update_gate.block_for_unconfirmed_command();
        }
        // Publish after removal so a waiting launch never observes this entry again.
        self.outcome.send_replace(Some(confirmed));
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

    /// A cancellation's wait for the owner registered as `serial` timed out.
    /// Only when this is the first fence does it record that owner's last
    /// published phase, read under the same lock that inserts the fence, or
    /// `released` once that registration is gone. A later owner outcome never
    /// supplies it, and it never replaces an earlier fence.
    fn fence_cancel_wait_timeout(&self, command_id: &str, serial: u64) {
        {
            let mut state = self.state();
            if state.fence.is_none() {
                let phase = state
                    .running
                    .get(command_id)
                    .filter(|running| running.serial == serial)
                    .map_or(CancelWaitOwnerPhase::Released, |running| {
                        running.phase.load()
                    });
                state.fence = Some(Fence::cancel_wait_timeout(phase));
            }
        }
        self.update_gate.block_for_unconfirmed_command();
    }

    #[cfg(all(test, unix))]
    fn fence_origin_receipt(&self) -> Option<FenceOriginReceipt> {
        self.fence_receipts().map(|receipts| receipts.origin)
    }

    /// The first recorded origin of the admission fence, as its closed v1
    /// receipt, or None while admission is not fenced. Beside it, only for an
    /// explicit stop request or an owner's own timeout whose unconfirmed leg
    /// was recorded with that origin, the leg's closed v1 receipt, and only
    /// for either origin's `tree_unconfirmed` leg from the Windows taskkill
    /// path, that failure's closed v1 receipt, and its closed v2 receipt when
    /// it has one. Only beside a stop request's report of taskkill's not-found
    /// exit code, `requested_pid_not_found` or `unclassified`, the same stop
    /// request's first source as its closed v1 receipt; a timeout never has
    /// one. Only on macOS, for a stop request's `tree_unconfirmed` leg from
    /// the Unix tree stop, its first source and final group probe class as
    /// their closed v1 receipt. Only for a cancellation wait timeout, its
    /// matched owner's closed v1 phase receipt.
    pub(crate) fn fence_receipts(&self) -> Option<FenceReceipts> {
        self.state().fence.map(|fence| FenceReceipts {
            origin: FenceOriginReceipt {
                version: 1,
                origin: fence.origin,
            },
            cleanup: fence.cleanup.map(|failure| FenceCleanupReceipt {
                version: 1,
                failure,
            }),
            windows_taskkill: fence.taskkill.map(FenceWindowsTaskkillReceipt::from),
            windows_taskkill_root_report: fence
                .taskkill
                .and_then(FenceWindowsTaskkillReceipt::with_root_report),
            cancel_wait_owner_phase: fence
                .owner_phase
                .map(|phase| FenceCancelWaitOwnerPhaseReceipt { version: 1, phase }),
            stop_request_source: fence
                .stop_source
                .filter(|_| fence.origin == FenceOrigin::OwnerStopRequested)
                .filter(|_| fence.taskkill.is_some_and(exposes_stop_request_source))
                .map(|source| FenceStopRequestSourceReceipt { version: 1, source }),
            darwin_stop: darwin_stop_receipt(fence, cfg!(target_os = "macos")),
        })
    }

    /// Capture synchronously while the IPC is dispatched. An async command body
    /// runs only at its spawned task's first poll, which can follow a page
    /// replacement, so it must receive this value rather than call it.
    pub(crate) fn admit(&self) -> Admission {
        Admission(self.state().generation)
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state().generation
    }

    /// The admitting document is gone: fence its pending launches and ask every
    /// running owner to stop. Never blocks; callers may await the cleanups.
    pub(crate) fn invalidate(&self) -> (u64, Vec<Cleanup>) {
        self.invalidate_requested_by(StopRequestSource::DocumentInvalidation)
    }

    /// Normal application exit: exactly `invalidate`, recorded as its own
    /// stop request source.
    pub(crate) fn invalidate_for_exit(&self) -> (u64, Vec<Cleanup>) {
        self.invalidate_requested_by(StopRequestSource::ApplicationExit)
    }

    fn invalidate_requested_by(&self, source: StopRequestSource) -> (u64, Vec<Cleanup>) {
        let mut state = self.state();
        state.generation += 1;
        let current = state.generation;
        let cleanups = state
            .running
            .values()
            .filter(|running| running.generation < current)
            .map(|running| {
                running.request_stop(source);
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
        let (unproven, completion, phase) = loop {
            let pending: Vec<Cleanup> = {
                let mut state = self.state();
                if state.canceled.contains(command_id) {
                    return Ok(Launch::Canceled);
                }
                if admission.0 != state.generation {
                    return Err(PAGE_REPLACED.to_string());
                }
                if state.fence.is_some() {
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
                    let (child, tree) = match spawn_owned(cmd) {
                        Ok(spawned) => spawned,
                        Err(SpawnFailure::NotStarted(message)) => return Err(message),
                        Err(SpawnFailure::Unproven(unproven)) => {
                            // A shell that may have run untracked fences
                            // admission under the lock that rejected it, so
                            // no later launch is admitted while it is cleaned
                            // up. One that never ran cannot need the fence.
                            if unproven.may_have_run() {
                                state
                                    .fence
                                    .get_or_insert(FenceOrigin::OwnerProcessError.into());
                            }
                            // A created shell is registered like any other
                            // under this same lock, so cancellation, page
                            // invalidation and app exit wait for its cleanup.
                            let (_, completion, phase) = self.register(&mut state, command_id);
                            break (unproven, completion, phase);
                        }
                    };
                    let (stop, completion, phase) = self.register(&mut state, command_id);
                    return Ok(Launch::Started(OwnedCommand {
                        child,
                        tree,
                        stop,
                        completion,
                        phase,
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
        };
        self.reject_unproven(unproven, completion, phase).await
    }

    /// Register a created shell's owner in the current generation. Called
    /// under the state lock that admitted it, so no cancellation or
    /// invalidation can miss it. Until its owner records a final outcome, a
    /// released registration is unconfirmed with a missing outcome.
    fn register(
        self: &Arc<Self>,
        state: &mut State,
        command_id: &str,
    ) -> (
        watch::Receiver<Option<StopRequestSource>>,
        Completion,
        OwnerPhase,
    ) {
        state.next_serial += 1;
        let serial = state.next_serial;
        let (stop, stop_requested) = watch::channel(None);
        let (outcome, cleanup) = watch::channel(None);
        let phase = OwnerPhase::default();
        state.running.insert(
            command_id.to_string(),
            Running {
                serial,
                generation: state.generation,
                stop,
                cleanup,
                phase: phase.clone(),
            },
        );
        let completion = Completion {
            lifecycle: self.clone(),
            command_id: command_id.to_string(),
            serial,
            outcome,
            unconfirmed: Some(FenceOrigin::OwnerOutcomeMissing.into()),
        };
        (stop_requested, completion, phase)
    }

    /// Stop and reap a registered shell that was never proven to run inside
    /// its tree, then release its registration and reject its launch. Every
    /// stop request already waits on that release. Only a cleanup that
    /// confirmed the stop and reap of a shell that never ran outside its Job
    /// releases it confirmed; anything else records an owner's process error,
    /// which fences admission and updates. If this future is dropped first,
    /// the registration keeps its missing outcome, which fences as well.
    async fn reject_unproven(
        &self,
        unproven: Unproven,
        mut completion: Completion,
        phase: OwnerPhase,
    ) -> Result<Launch, String> {
        let may_have_run = unproven.may_have_run();
        if may_have_run {
            // Admission was fenced under the launch lock; updates are fenced
            // only after it was released, as every owner's release orders them.
            self.update_gate.block_for_unconfirmed_command();
        }
        phase.publish(OwnerPhase::OWNER_CLEANUP);
        let confirmed = unproven.clean_up().await && !may_have_run;
        completion.unconfirmed = unless_confirmed(confirmed, FenceOrigin::OwnerProcessError);
        // Releases the registration and publishes its outcome to any waiter.
        drop(completion);
        let message = if confirmed {
            UNPROVEN_LAUNCH
        } else {
            STOP_UNCONFIRMED
        };
        Err(message.to_string())
    }

    /// Record a tombstone and ask the owner, if running, to stop. True only when
    /// no process is running or its owner confirmed the tree stopped.
    pub(crate) async fn cancel(&self, command_id: &str) -> bool {
        let matched = {
            let mut state = self.state();
            state.canceled.insert(command_id.to_string());
            state.running.get(command_id).map(|running| {
                running.request_stop(StopRequestSource::CancelIpc);
                (running.serial, running.cleanup.clone())
            })
        };
        // Either it already exited, or its future launch is now fenced. A
        // concurrent launch cannot pass the fence before registering itself.
        let Some((serial, cleanup)) = matched else {
            return true;
        };
        match tokio::time::timeout(CANCEL_WAIT, resolved(vec![cleanup])).await {
            Ok(confirmed) => confirmed,
            // An owner that has not answered is an unknown outcome.
            Err(_) => {
                self.fence_cancel_wait_timeout(command_id, serial);
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
    StopRequested(StopRequestSource),
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
    // A normal exit drops `tree` without stopping anything: on Windows this
    // only closes the Job handle, so intentional background jobs keep running.
    let OwnedCommand {
        mut child,
        tree,
        mut stop,
        mut completion,
        phase,
    } = owned;
    phase.publish(OwnerPhase::STREAMING);
    let ended = {
        let streaming = stream_until_exit(&mut child, input, on_event);
        tokio::select! {
            biased;
            source = stop_requested(&mut stop) => Ended::StopRequested(source),
            result = tokio::time::timeout(timeout, streaming) => {
                result.unwrap_or(Ended::TimedOut)
            }
        }
    };
    // Assigned only once the bounded cleanup below has finished, so an owner
    // released while it is still pending keeps `OwnerOutcomeMissing`.
    completion.unconfirmed = match ended {
        Ended::Exited(status) => {
            phase.publish(OwnerPhase::TERMINAL_DELIVERY);
            let _ = on_event.send(StreamEvent::Exit {
                exit_code: status.code().unwrap_or(-1),
            });
            None
        }
        Ended::ProcessError(e) => {
            phase.publish(OwnerPhase::OWNER_CLEANUP);
            let confirmed = graceful_kill_owned(&mut child, &tree).await.confirmed();
            phase.publish(OwnerPhase::TERMINAL_DELIVERY);
            let _ = on_event.send(StreamEvent::Error {
                message: format!("Process error: {}", e),
            });
            unless_confirmed(confirmed, FenceOrigin::OwnerProcessError)
        }
        Ended::TimedOut => {
            phase.publish(OwnerPhase::OWNER_CLEANUP);
            let killed = graceful_kill_owned(&mut child, &tree).await;
            phase.publish(OwnerPhase::TERMINAL_DELIVERY);
            let _ = on_event.send(StreamEvent::Error {
                message: format!("Command timed out after {}ms", timeout.as_millis()),
            });
            Fence::owner_timeout(killed)
        }
        Ended::StopRequested(source) => {
            let (fence, status) = terminate_owned(&mut child, &tree, Some(&phase)).await;
            phase.publish(OwnerPhase::TERMINAL_DELIVERY);
            let _ = on_event.send(match status {
                Some(status) => StreamEvent::Exit {
                    exit_code: status.code().unwrap_or(-1),
                },
                None => StreamEvent::Error {
                    message: "Desktop could not confirm the command stopped".to_string(),
                },
            });
            // The source this owner observed with its stop request: the first.
            fence.map(|fence| fence.requested_by(source))
        }
        // The receiver is gone: stop producing output nobody can deliver.
        Ended::DeliveryFailed => {
            phase.publish(OwnerPhase::OWNER_CLEANUP);
            let confirmed = terminate_owned(&mut child, &tree, None).await.0.is_none();
            phase.publish(OwnerPhase::TERMINAL_DELIVERY);
            unless_confirmed(confirmed, FenceOrigin::OwnerDeliveryFailed)
        }
    };
}

fn unless_confirmed(confirmed: bool, origin: FenceOrigin) -> Option<Fence> {
    (!confirmed).then_some(origin.into())
}

/// Resolves to the first stop request's source once any request was made.
async fn stop_requested(
    stop: &mut watch::Receiver<Option<StopRequestSource>>,
) -> StopRequestSource {
    match stop
        .wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|first| *first)
    {
        Some(source) => source,
        // The registration outlives its owner, so this is unreachable; never
        // treat a closed signal as a stop request.
        None => std::future::pending().await,
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
    let mut stdout_text = Utf8Stream::default();
    let mut stderr_text = Utf8Stream::default();
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
            result = stdout.read(&mut stdout_buf), if !stdout_done => {
                let data = match result {
                    Ok(0) | Err(_) => {
                        stdout_done = true;
                        stdout_text.finish()
                    }
                    Ok(n) => stdout_text.decode(&stdout_buf[..n]),
                };
                if let Some(data) = data {
                    if on_event.send(StreamEvent::Stdout { data }).is_err() {
                        return Ended::DeliveryFailed;
                    }
                }
            }
            result = stderr.read(&mut stderr_buf), if !stderr_done => {
                let data = match result {
                    Ok(0) | Err(_) => {
                        stderr_done = true;
                        stderr_text.finish()
                    }
                    Ok(n) => stderr_text.decode(&stderr_buf[..n]),
                };
                if let Some(data) = data {
                    if on_event.send(StreamEvent::Stderr { data }).is_err() {
                        return Ended::DeliveryFailed;
                    }
                }
            }
        }
    }
    match child.wait().await {
        Ok(status) => Ended::Exited(status),
        Err(e) => Ended::ProcessError(e),
    }
}

/// Stop the owned tree while reaping its leader concurrently: an unreaped
/// leader keeps its process group alive. Confirmed (None) only when no check
/// failed; otherwise the fence a stop request records for those checks. With
/// `phase`, a stop request's cleanup publishes which checks are outstanding.
async fn terminate_owned(
    child: &mut Child,
    tree: &OwnedTree,
    phase: Option<&OwnerPhase>,
) -> (Option<Fence>, Option<ExitStatus>) {
    let Some(tree) = stop_tree(tree, child) else {
        // Already reaped by this owner; no live PID remains to signal.
        return (None, child.try_wait().ok().flatten());
    };
    let leader = tokio::time::timeout(REAP_TIMEOUT, child.wait());
    if let Some(phase) = phase {
        phase.publish(
            OwnerPhase::STOP_CLEANUP | OwnerPhase::TREE_PENDING | OwnerPhase::LEADER_PENDING,
        );
    }
    let (stopped, waited) = tokio::join!(
        tracked(tree, phase, OwnerPhase::TREE_PENDING),
        tracked(leader, phase, OwnerPhase::LEADER_PENDING)
    );
    let (leader, status) = match waited {
        Ok(Ok(status)) => (LeaderWait::Reaped, Some(status)),
        Ok(Err(_)) => (LeaderWait::Failed, None),
        Err(_) => (LeaderWait::TimedOut, None),
    };
    let fence = cleanup_failure(stopped.is_ok(), leader)
        .map(|failure| Fence::stop_requested_after(failure, stopped.err().flatten()));
    (fence, status)
}

/// The unconfirmed checks, or None only when the tree stopped and the leader
/// was reaped.
fn cleanup_failure(tree_stopped: bool, leader: LeaderWait) -> Option<CleanupFailure> {
    use CleanupFailure::*;
    match (tree_stopped, leader) {
        (true, LeaderWait::Reaped) => None,
        (false, LeaderWait::Reaped) => Some(TreeUnconfirmed),
        (true, LeaderWait::TimedOut) => Some(LeaderWaitTimedOut),
        (true, LeaderWait::Failed) => Some(LeaderWaitFailed),
        (false, LeaderWait::TimedOut) => Some(TreeAndLeaderWaitTimedOut),
        (false, LeaderWait::Failed) => Some(TreeAndLeaderWaitFailed),
    }
}

#[cfg(all(test, unix))]
impl OwnedCommand {
    /// Reap a finished test command, then release ownership as `run` does
    /// after a stop request first made by `source` whose cleanup reported
    /// `failure`, with `taskkill` as the tree stop's reported failure.
    pub(crate) async fn release_stop_unconfirmed(
        mut self,
        failure: CleanupFailure,
        taskkill: Option<TaskkillFailure>,
        source: StopRequestSource,
    ) {
        let _ = self.child.wait().await;
        self.completion.unconfirmed =
            Some(Fence::stop_requested(failure, taskkill).requested_by(source));
    }

    /// As `release_stop_unconfirmed`, with `tree` as the tree stop's reported
    /// failure, as `terminate_owned` records it.
    pub(crate) async fn release_stop_after(
        mut self,
        failure: CleanupFailure,
        tree: Option<TreeStopFailure>,
        source: StopRequestSource,
    ) {
        let _ = self.child.wait().await;
        self.completion.unconfirmed =
            Some(Fence::stop_requested_after(failure, tree).requested_by(source));
    }

    /// Reap a finished test command, then release ownership as `run` does
    /// after its own timeout whose `graceful_kill` reported `killed`.
    pub(crate) async fn release_timeout(mut self, killed: GracefulKill) {
        let _ = self.child.wait().await;
        self.completion.unconfirmed = Fence::owner_timeout(killed);
    }
}

#[cfg(all(test, unix))]
impl StreamLifecycle {
    /// Time out a cancellation's wait for `owned`, as `cancel` does at its
    /// deadline, without waiting for it.
    pub(crate) fn time_out_cancel_wait(&self, owned: &OwnedCommand) {
        self.fence_cancel_wait_timeout(&owned.completion.command_id, owned.completion.serial);
    }
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

    #[test]
    fn stream_lifecycle_fence_origin_receipt_serializes_only_its_closed_schema() {
        for (origin, wire) in [
            (FenceOrigin::OwnerTimeout, "owner_timeout"),
            (FenceOrigin::OwnerProcessError, "owner_process_error"),
            (FenceOrigin::OwnerStopRequested, "owner_stop_requested"),
            (FenceOrigin::OwnerDeliveryFailed, "owner_delivery_failed"),
            (FenceOrigin::OwnerOutcomeMissing, "owner_outcome_missing"),
            (FenceOrigin::CancelWaitTimeout, "cancel_wait_timeout"),
        ] {
            assert_eq!(
                serde_json::to_value(FenceOriginReceipt { version: 1, origin }).unwrap(),
                serde_json::json!({ "version": 1, "origin": wire })
            );
            // An unconfirmed owner reports its own path; a confirmed one none.
            assert_eq!(unless_confirmed(false, origin), Some(Fence::from(origin)));
            assert_eq!(unless_confirmed(true, origin), None);
        }
    }

    #[test]
    fn stream_lifecycle_cleanup_failure_names_exactly_the_unconfirmed_checks() {
        use LeaderWait::*;
        for (tree_stopped, leader, expected) in [
            (true, Reaped, None),
            (false, Reaped, Some("tree_unconfirmed")),
            (true, TimedOut, Some("leader_wait_timed_out")),
            (true, Failed, Some("leader_wait_failed")),
            (false, TimedOut, Some("tree_and_leader_wait_timed_out")),
            (false, Failed, Some("tree_and_leader_wait_failed")),
        ] {
            let failure = cleanup_failure(tree_stopped, leader);
            // Confirmation keeps its exact prior rule: tree stopped and leader reaped.
            assert_eq!(
                failure.is_none(),
                tree_stopped && matches!(leader, Reaped),
                "{tree_stopped} {leader:?}"
            );
            assert_eq!(
                failure.map(|failure| {
                    serde_json::to_value(FenceCleanupReceipt {
                        version: 1,
                        failure,
                    })
                    .unwrap()
                }),
                expected.map(|wire| serde_json::json!({ "version": 1, "failure": wire })),
                "{tree_stopped} {leader:?}"
            );
            // Taskkill's failure is kept only with the tree-only leg, by a stop
            // request and an owner's own timeout alike.
            let taskkill = TaskkillFailure::OutputError;
            let tree_only = !tree_stopped && matches!(leader, Reaped);
            assert_eq!(
                failure.and_then(|leg| Fence::stop_requested(leg, Some(taskkill)).taskkill),
                tree_only.then_some(taskkill),
                "{tree_stopped} {leader:?}"
            );
            let killed = GracefulKill {
                tree_stopped,
                leader,
                taskkill: (!tree_stopped).then_some(taskkill),
            };
            assert_eq!(
                Fence::owner_timeout(killed).and_then(|fence| fence.taskkill),
                tree_only.then_some(taskkill),
                "{tree_stopped} {leader:?}"
            );
        }
    }

    #[test]
    fn stream_lifecycle_owner_timeout_records_only_graceful_kill_unconfirmed_checks() {
        use LeaderWait::*;
        let reported = [
            None,
            Some(TaskkillFailure::RequestedPidNotFound),
            Some(TaskkillFailure::NonzeroExit(NonZeroI32::new(128))),
            Some(TaskkillFailure::NonzeroExit(NonZeroI32::new(255))),
            Some(TaskkillFailure::NonzeroExit(None)),
            Some(TaskkillFailure::OutputError),
        ];
        for tree_stopped in [true, false] {
            for leader in [Reaped, TimedOut, Failed] {
                // A confirmed tree stop reports no taskkill failure.
                let reports = if tree_stopped {
                    &reported[..1]
                } else {
                    &reported[..]
                };
                for &taskkill in reports {
                    let killed = GracefulKill {
                        tree_stopped,
                        leader,
                        taskkill,
                    };
                    let fence = Fence::owner_timeout(killed);
                    // Admission keeps `graceful_kill`'s exact Boolean rule.
                    assert_eq!(fence.is_none(), killed.confirmed(), "{killed:?}");
                    // The timeout origin with the same closed leg a stop
                    // names, its taskkill failure only beside the tree-only
                    // leg whose leader was reaped, and never a source.
                    let tree_only = !tree_stopped && leader == Reaped;
                    assert_eq!(
                        fence,
                        cleanup_failure(tree_stopped, leader).map(|failure| Fence {
                            cleanup: Some(failure),
                            taskkill: taskkill.filter(|_| tree_only),
                            ..FenceOrigin::OwnerTimeout.into()
                        }),
                        "{killed:?}"
                    );
                    for source in [
                        StopRequestSource::CancelIpc,
                        StopRequestSource::DocumentInvalidation,
                        StopRequestSource::ApplicationExit,
                    ] {
                        assert_eq!(
                            fence.map(|fence| fence.requested_by(source)),
                            fence,
                            "{killed:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn stream_lifecycle_owner_timeout_receipts_carry_its_taskkill_failure_but_never_a_source() {
        use serde_json::json;
        let receipts = |fence: Fence| {
            let lifecycle = StreamLifecycle::default();
            lifecycle.state().fence = Some(fence);
            lifecycle.fence_receipts().expect("fenced")
        };
        let tree_only = |taskkill| {
            Fence::owner_timeout(GracefulKill {
                tree_stopped: false,
                leader: LeaderWait::Reaped,
                taskkill: Some(taskkill),
            })
            .expect("unconfirmed")
        };
        // [failure, exact v1 receipt, v2 receipt when it has one]
        for (taskkill, v1, v2) in [
            (
                TaskkillFailure::RequestedPidNotFound,
                json!({ "version": 1, "outcome": "nonzero_exit", "exitCode": 128 }),
                Some(json!({
                    "version": 2,
                    "outcome": "nonzero_exit",
                    "exitCode": 128,
                    "rootReport": "requested_pid_not_found",
                })),
            ),
            (
                TaskkillFailure::NonzeroExit(NonZeroI32::new(128)),
                json!({ "version": 1, "outcome": "nonzero_exit", "exitCode": 128 }),
                Some(json!({
                    "version": 2,
                    "outcome": "nonzero_exit",
                    "exitCode": 128,
                    "rootReport": "unclassified",
                })),
            ),
            (
                TaskkillFailure::NonzeroExit(None),
                json!({ "version": 1, "outcome": "nonzero_exit" }),
                None,
            ),
            (
                TaskkillFailure::OutputError,
                json!({ "version": 1, "outcome": "output_error" }),
                None,
            ),
        ] {
            let fence = tree_only(taskkill);
            let read = receipts(fence);
            assert_eq!(
                serde_json::to_value(read.origin).unwrap(),
                json!({ "version": 1, "origin": "owner_timeout" })
            );
            assert_eq!(
                serde_json::to_value(read.cleanup).unwrap(),
                json!({ "version": 1, "failure": "tree_unconfirmed" })
            );
            assert_eq!(
                read.windows_taskkill
                    .map(|receipt| serde_json::to_value(receipt).unwrap()),
                Some(v1),
                "{taskkill:?}"
            );
            assert_eq!(
                read.windows_taskkill_root_report
                    .map(|receipt| serde_json::to_value(receipt).unwrap()),
                v2,
                "{taskkill:?}"
            );
            assert_eq!(read.stop_request_source, None, "{taskkill:?}");
            assert_eq!(read.cancel_wait_owner_phase, None, "{taskkill:?}");
            // Even a source forged onto the timeout's own fence is never read.
            let forged = receipts(Fence {
                stop_source: Some(StopRequestSource::CancelIpc),
                ..fence
            });
            assert_eq!(forged.stop_request_source, None, "{taskkill:?}");
        }
        // A combined failure's taskkill report is never recorded.
        for leader in [LeaderWait::TimedOut, LeaderWait::Failed] {
            let read = receipts(
                Fence::owner_timeout(GracefulKill {
                    tree_stopped: false,
                    leader,
                    taskkill: Some(TaskkillFailure::RequestedPidNotFound),
                })
                .expect("unconfirmed"),
            );
            assert!(read.cleanup.is_some(), "{leader:?}");
            assert_eq!(read.windows_taskkill, None, "{leader:?}");
            assert_eq!(read.windows_taskkill_root_report, None, "{leader:?}");
        }
    }

    #[test]
    fn stream_lifecycle_windows_taskkill_receipt_serializes_only_its_closed_schema() {
        use serde_json::json;
        let report = |code: i32, class: &str| {
            json!({
                "version": 2,
                "outcome": "nonzero_exit",
                "exitCode": code,
                "rootReport": class,
            })
        };
        // [failure, exact v1 receipt, v2 receipt when it has one]
        for (failure, v1, v2) in [
            (
                TaskkillFailure::NonzeroExit(NonZeroI32::new(128)),
                json!({ "version": 1, "outcome": "nonzero_exit", "exitCode": 128 }),
                Some(report(128, "unclassified")),
            ),
            (
                TaskkillFailure::NonzeroExit(NonZeroI32::new(255)),
                json!({ "version": 1, "outcome": "nonzero_exit", "exitCode": 255 }),
                Some(report(255, "unclassified")),
            ),
            (
                TaskkillFailure::NonzeroExit(NonZeroI32::new(-1_073_741_510)),
                json!({ "version": 1, "outcome": "nonzero_exit", "exitCode": -1_073_741_510 }),
                Some(report(-1_073_741_510, "unclassified")),
            ),
            // The classified report keeps the exact v1 bytes of its exit.
            (
                TaskkillFailure::RequestedPidNotFound,
                json!({ "version": 1, "outcome": "nonzero_exit", "exitCode": 128 }),
                Some(report(128, "requested_pid_not_found")),
            ),
            (
                TaskkillFailure::NonzeroExit(None),
                json!({ "version": 1, "outcome": "nonzero_exit" }),
                None,
            ),
            (
                TaskkillFailure::OutputError,
                json!({ "version": 1, "outcome": "output_error" }),
                None,
            ),
        ] {
            assert_eq!(
                serde_json::to_value(FenceWindowsTaskkillReceipt::from(failure)).unwrap(),
                v1,
                "{failure:?}"
            );
            assert_eq!(
                FenceWindowsTaskkillReceipt::with_root_report(failure)
                    .map(|receipt| serde_json::to_value(receipt).unwrap()),
                v2,
                "{failure:?}"
            );
        }
    }

    #[test]
    fn stream_lifecycle_cancel_wait_owner_phase_serializes_only_its_closed_schema() {
        use CancelWaitOwnerPhase::*;
        let phase = OwnerPhase::default();
        let stop = OwnerPhase::STOP_CLEANUP;
        let (tree, leader) = (OwnerPhase::TREE_PENDING, OwnerPhase::LEADER_PENDING);
        // [published step, its phase, its wire name]
        for (step, expected, wire) in [
            (OwnerPhase::PENDING, OwnerPending, "owner_pending"),
            (OwnerPhase::STREAMING, OwnerStreaming, "owner_streaming"),
            (
                stop | tree | leader,
                StopCleanupTreeAndLeaderPending,
                "stop_cleanup_tree_and_leader_pending",
            ),
            (
                stop | tree,
                StopCleanupTreePending,
                "stop_cleanup_tree_pending",
            ),
            (
                stop | leader,
                StopCleanupLeaderPending,
                "stop_cleanup_leader_pending",
            ),
            // Both checks returned: about to deliver.
            (stop, TerminalDelivery, "terminal_delivery"),
            (OwnerPhase::OWNER_CLEANUP, OwnerCleanup, "owner_cleanup"),
            (
                OwnerPhase::TERMINAL_DELIVERY,
                TerminalDelivery,
                "terminal_delivery",
            ),
        ] {
            phase.publish(step);
            assert_eq!(phase.load(), expected, "{step:#06b}");
            assert_eq!(
                serde_json::to_value(FenceCancelWaitOwnerPhaseReceipt {
                    version: 1,
                    phase: expected,
                })
                .unwrap(),
                serde_json::json!({ "version": 1, "phase": wire })
            );
        }
        assert_eq!(
            serde_json::to_value(FenceCancelWaitOwnerPhaseReceipt {
                version: 1,
                phase: Released,
            })
            .unwrap(),
            serde_json::json!({ "version": 1, "phase": "released" })
        );
        // Only a cancellation wait timeout's fence carries a phase.
        assert_eq!(
            Fence::cancel_wait_timeout(Released),
            Fence {
                owner_phase: Some(Released),
                ..FenceOrigin::CancelWaitTimeout.into()
            }
        );
        assert_eq!(
            Fence::stop_requested(CleanupFailure::TreeUnconfirmed, None).owner_phase,
            None
        );
    }

    #[test]
    fn stream_lifecycle_stop_request_source_is_read_only_beside_its_not_found_exit_report() {
        use CleanupFailure::*;
        use TaskkillFailure::*;
        let receipt = |fence: Fence| {
            let lifecycle = StreamLifecycle::default();
            lifecycle.state().fence = Some(fence);
            lifecycle
                .fence_receipts()
                .and_then(|receipts| receipts.stop_request_source)
        };
        // Taskkill's not-found exit, classified or not.
        let not_found_exits = [
            Fence::stop_requested(TreeUnconfirmed, Some(RequestedPidNotFound)),
            Fence::stop_requested(
                TreeUnconfirmed,
                Some(NonzeroExit(Some(crate::platform::TASKKILL_NOT_FOUND_EXIT))),
            ),
        ];
        for not_found in not_found_exits {
            // A fence recorded without a source never has one.
            assert_eq!(receipt(not_found), None, "{not_found:?}");
        }
        for (source, wire) in [
            (StopRequestSource::CancelIpc, "cancel_ipc"),
            (
                StopRequestSource::DocumentInvalidation,
                "document_invalidation",
            ),
            (StopRequestSource::ApplicationExit, "application_exit"),
        ] {
            let expected = FenceStopRequestSourceReceipt { version: 1, source };
            assert_eq!(
                serde_json::to_value(expected).unwrap(),
                serde_json::json!({ "version": 1, "source": wire })
            );
            for not_found in not_found_exits {
                let requested = not_found.requested_by(source);
                assert_eq!(receipt(requested), Some(expected), "{not_found:?}");
            }
            // Every stop request records its source, but only the not-found
            // exit's report beside a tree-only leg exposes it.
            for fence in [
                Fence::stop_requested(TreeUnconfirmed, Some(NonzeroExit(NonZeroI32::new(255)))),
                Fence::stop_requested(TreeUnconfirmed, Some(NonzeroExit(NonZeroI32::new(1)))),
                Fence::stop_requested(
                    TreeUnconfirmed,
                    Some(NonzeroExit(NonZeroI32::new(-1_073_741_510))),
                ),
                Fence::stop_requested(TreeUnconfirmed, Some(NonzeroExit(None))),
                Fence::stop_requested(TreeUnconfirmed, Some(OutputError)),
                Fence::stop_requested(TreeUnconfirmed, None),
                Fence::stop_requested(TreeAndLeaderWaitFailed, Some(RequestedPidNotFound)),
                Fence::stop_requested(LeaderWaitTimedOut, Some(RequestedPidNotFound)),
            ] {
                let requested = fence.requested_by(source);
                assert_eq!(requested.stop_source, Some(source), "{fence:?}");
                assert_eq!(receipt(requested), None, "{fence:?}");
            }
            // No other origin ever records one.
            for origin in [
                FenceOrigin::OwnerTimeout,
                FenceOrigin::OwnerProcessError,
                FenceOrigin::OwnerDeliveryFailed,
                FenceOrigin::OwnerOutcomeMissing,
            ] {
                assert_eq!(Fence::from(origin).requested_by(source), origin.into());
            }
            let timed_out = Fence::cancel_wait_timeout(CancelWaitOwnerPhase::OwnerStreaming);
            assert_eq!(timed_out.requested_by(source), timed_out);
        }
    }

    #[test]
    fn stream_lifecycle_darwin_stop_receipt_is_read_only_beside_a_tree_only_stops_group_probe() {
        use CleanupFailure::*;
        use GroupProbe::*;
        let probed =
            |leg, probe| Fence::stop_requested_after(leg, Some(TreeStopFailure::GroupProbe(probe)));
        let read = |fence: Fence| {
            let lifecycle = StreamLifecycle::default();
            lifecycle.state().fence = Some(fence);
            lifecycle.fence_receipts().expect("fenced")
        };
        for (probe, probe_wire) in [
            (GroupVisible, "group_visible"),
            (ProbeDenied, "probe_denied"),
            (ProbeFailed, "probe_failed"),
        ] {
            for (source, source_wire) in [
                (StopRequestSource::CancelIpc, "cancel_ipc"),
                (
                    StopRequestSource::DocumentInvalidation,
                    "document_invalidation",
                ),
                (StopRequestSource::ApplicationExit, "application_exit"),
            ] {
                let label = format!("{probe:?} {source:?}");
                let expected = FenceDarwinStopReceipt {
                    version: 1,
                    source,
                    group_probe: probe,
                };
                assert_eq!(
                    serde_json::to_value(expected).unwrap(),
                    serde_json::json!({
                        "version": 1,
                        "source": source_wire,
                        "groupProbe": probe_wire,
                    }),
                    "{label}"
                );
                let stop = probed(TreeUnconfirmed, probe).requested_by(source);
                // The same stop's first source and probe, only on macOS.
                assert_eq!(darwin_stop_receipt(stop, true), Some(expected), "{label}");
                assert_eq!(darwin_stop_receipt(stop, false), None, "{label}");
                let receipts = read(stop);
                assert_eq!(
                    receipts.darwin_stop,
                    cfg!(target_os = "macos").then_some(expected),
                    "{label}"
                );
                // Every other receipt keeps its prior shape.
                assert_eq!(
                    receipts.cleanup,
                    Some(FenceCleanupReceipt {
                        version: 1,
                        failure: TreeUnconfirmed,
                    }),
                    "{label}"
                );
                assert_eq!(receipts.windows_taskkill, None, "{label}");
                assert_eq!(receipts.windows_taskkill_root_report, None, "{label}");
                assert_eq!(receipts.stop_request_source, None, "{label}");
                assert_eq!(receipts.cancel_wait_owner_phase, None, "{label}");

                // Recorded only beside the tree-only leg: a combined leg's
                // probe is dropped, and a leader-only leg never reports one.
                for leg in [
                    TreeAndLeaderWaitTimedOut,
                    TreeAndLeaderWaitFailed,
                    LeaderWaitTimedOut,
                    LeaderWaitFailed,
                ] {
                    let fence = probed(leg, probe).requested_by(source);
                    assert_eq!(fence.group_probe, None, "{label} {leg:?}");
                    assert_eq!(darwin_stop_receipt(fence, true), None, "{label}");
                }
                // A stop without a recorded source, or a forged probe beside a
                // taskkill failure, a timeout or any other origin, never has one.
                assert_eq!(
                    darwin_stop_receipt(probed(TreeUnconfirmed, probe), true),
                    None
                );
                let forged = [
                    Fence {
                        taskkill: Some(TaskkillFailure::OutputError),
                        ..stop
                    },
                    Fence {
                        origin: FenceOrigin::OwnerTimeout,
                        ..stop
                    },
                    Fence {
                        origin: FenceOrigin::OwnerOutcomeMissing,
                        ..stop
                    },
                ];
                for fence in forged {
                    assert_eq!(darwin_stop_receipt(fence, true), None, "{fence:?}");
                }
            }
        }
        // Windows' taskkill failure keeps exactly its prior fence, never a
        // probe; a tree stop without a reported failure records neither.
        let taskkill = TaskkillFailure::RequestedPidNotFound;
        assert_eq!(
            Fence::stop_requested_after(TreeUnconfirmed, Some(TreeStopFailure::Taskkill(taskkill))),
            Fence::stop_requested(TreeUnconfirmed, Some(taskkill))
        );
        assert_eq!(
            Fence::stop_requested_after(TreeUnconfirmed, None),
            Fence::stop_requested(TreeUnconfirmed, None)
        );
    }

    /// A test-owned temporary directory, removed on drop.
    pub(super) struct Scratch(std::path::PathBuf);
    impl Scratch {
        pub(super) fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hackerai-stream-lifecycle-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        pub(super) fn path(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(super) fn collecting_channel() -> (Channel<StreamEvent>, Arc<Mutex<Vec<String>>>) {
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

    pub(super) fn started(launch: Result<Launch, String>) -> OwnedCommand {
        match launch.expect("launch should be admitted") {
            Launch::Started(owned) => owned,
            Launch::Canceled => panic!("launch was unexpectedly canceled"),
        }
    }

    /// A private gate, so a test's unknown outcome cannot fence the
    /// process-wide updater used by other tests.
    pub(super) fn private_gate() -> &'static UpdateGate {
        Box::leak(Box::new(UpdateGate::default()))
    }

    /// Yield until `phase` reads `expected`, so a spawned check can run.
    pub(super) async fn reaches(phase: &OwnerPhase, expected: CancelWaitOwnerPhase) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while phase.load() != expected {
            assert!(
                std::time::Instant::now() < deadline,
                "never reached {expected:?}; last {:?}",
                phase.load()
            );
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn stream_lifecycle_owner_phase_clears_each_concurrent_stop_check_as_it_returns() {
        use CancelWaitOwnerPhase::*;
        // Either check may return first; the other remains outstanding.
        for leader_first in [true, false] {
            let phase = OwnerPhase::default();
            phase.publish(
                OwnerPhase::STOP_CLEANUP | OwnerPhase::TREE_PENDING | OwnerPhase::LEADER_PENDING,
            );
            let (tree_done, tree) = tokio::sync::oneshot::channel::<u8>();
            let (leader_done, leader) = tokio::sync::oneshot::channel::<u8>();
            let checks = tokio::spawn({
                let phase = phase.clone();
                async move {
                    tokio::join!(
                        tracked(tree, Some(&phase), OwnerPhase::TREE_PENDING),
                        tracked(leader, Some(&phase), OwnerPhase::LEADER_PENDING)
                    )
                }
            });
            tokio::task::yield_now().await;
            assert_eq!(phase.load(), StopCleanupTreeAndLeaderPending);
            if leader_first {
                leader_done.send(2).unwrap();
                reaches(&phase, StopCleanupTreePending).await;
                tree_done.send(1).unwrap();
            } else {
                tree_done.send(1).unwrap();
                reaches(&phase, StopCleanupLeaderPending).await;
                leader_done.send(2).unwrap();
            }
            // Each check's own output is returned unchanged.
            let (tree, leader) = checks.await.unwrap();
            assert_eq!((tree.unwrap(), leader.unwrap()), (1, 2));
            assert_eq!(phase.load(), TerminalDelivery);
        }
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::tests::{collecting_channel, private_gate, started, Scratch};
    use super::*;
    use crate::platform;
    use std::path::Path;
    use std::time::Instant;

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

    /// A long-running tree: a backgrounded descendant whose PID is recorded,
    /// then a marker line once everything is running.
    fn long_tree(scratch: &Scratch, marker: &str) -> String {
        format!(
            "sleep 60 & echo $! > {}; printf '{marker}\\n' >> {}; wait",
            quoted(&scratch.path("descendant")),
            quoted(&scratch.path("runs")),
        )
    }

    /// `command` under a test-owned `/bin/sh -c`, never the user's login
    /// shell, leading its own process group with piped output, as
    /// `build_command` places a command.
    fn fixed_shell(command: &str) -> tokio::process::Command {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(command)
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        cmd.into()
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
            tree,
            completion,
            ..
        } = owned;
        assert_eq!(terminate_owned(&mut child, &tree, None).await.0, None);
        assert!(!group_alive(leader));
        assert!(!process_alive(descendant));
        assert_eq!(lifecycle.fence_origin_receipt(), None);
        drop(completion);

        assert_eq!(successor.await.unwrap().as_deref(), Some(STOP_UNCONFIRMED));
        // Released before `run` recorded any outcome.
        assert_eq!(
            lifecycle
                .fence_origin_receipt()
                .map(|receipt| receipt.origin),
            Some(FenceOrigin::OwnerOutcomeMissing)
        );
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

    /// Stop the test-owned tree exactly, then release ownership with `fence`
    /// as `run`'s recorded final outcome, or confirmed when None.
    async fn release_with(owned: OwnedCommand, fence: Option<Fence>) {
        let OwnedCommand {
            mut child,
            tree,
            mut completion,
            ..
        } = owned;
        assert_eq!(terminate_owned(&mut child, &tree, None).await.0, None);
        completion.unconfirmed = fence;
    }

    /// As `release_with`, for an outcome that records no cleanup leg.
    async fn release(owned: OwnedCommand, origin: Option<FenceOrigin>) {
        release_with(owned, origin.map(Fence::from)).await;
    }

    fn origin(lifecycle: &StreamLifecycle) -> Option<FenceOrigin> {
        lifecycle
            .fence_origin_receipt()
            .map(|receipt| receipt.origin)
    }

    fn cleanup(lifecycle: &StreamLifecycle) -> Option<CleanupFailure> {
        lifecycle
            .fence_receipts()
            .and_then(|receipts| receipts.cleanup)
            .map(|receipt| receipt.failure)
    }

    fn windows_taskkill(lifecycle: &StreamLifecycle) -> Option<FenceWindowsTaskkillReceipt> {
        lifecycle
            .fence_receipts()
            .and_then(|receipts| receipts.windows_taskkill)
    }

    fn owner_phase(lifecycle: &StreamLifecycle) -> Option<CancelWaitOwnerPhase> {
        lifecycle
            .fence_receipts()
            .and_then(|receipts| receipts.cancel_wait_owner_phase)
            .map(|receipt| receipt.phase)
    }

    fn stop_request_source(lifecycle: &StreamLifecycle) -> Option<StopRequestSource> {
        lifecycle
            .fence_receipts()
            .and_then(|receipts| receipts.stop_request_source)
            .map(|receipt| receipt.source)
    }

    /// Yield until a stop request wakes the owner, then mark it seen and
    /// return the source the owner would observe.
    async fn woken(
        stop: &mut watch::Receiver<Option<StopRequestSource>>,
    ) -> Option<StopRequestSource> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !stop.has_changed().unwrap() {
            assert!(
                Instant::now() < deadline,
                "the request never woke its owner"
            );
            tokio::task::yield_now().await;
        }
        *stop.borrow_and_update()
    }

    /// Each source first, then both others: every request still wakes the
    /// owner, none replaces the first source, and the owner's existing stop is
    /// unchanged: it confirms its tree stopped and records no fence.
    #[tokio::test]
    async fn stream_lifecycle_owner_keeps_its_first_stop_request_source_across_competing_requests()
    {
        use StopRequestSource::*;
        let all = [CancelIpc, DocumentInvalidation, ApplicationExit];
        for first in all {
            let scratch = Scratch::new();
            let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
            let mut cmd = platform::build_command(&long_tree(&scratch, "owner"), None, None);
            let mut owned = started(lifecycle.launch(lifecycle.admit(), "owner", &mut cmd).await);
            let leader = owned.child.id().unwrap();
            let descendant: libc::pid_t = wait_for_file(&scratch.path("descendant"))
                .await
                .parse()
                .unwrap();
            assert_eq!(*owned.stop.borrow_and_update(), None);
            let mut canceling = None;
            let others = all.into_iter().filter(|source| *source != first);
            for source in std::iter::once(first).chain(others) {
                match source {
                    // The cancel IPC waits for the owner, so it runs aside.
                    CancelIpc => {
                        canceling = Some(tokio::spawn({
                            let lifecycle = lifecycle.clone();
                            async move { lifecycle.cancel("owner").await }
                        }))
                    }
                    DocumentInvalidation => drop(lifecycle.invalidate()),
                    ApplicationExit => drop(lifecycle.invalidate_for_exit()),
                }
                assert_eq!(woken(&mut owned.stop).await, Some(first), "{source:?}");
            }
            assert_eq!(stop_requested(&mut owned.stop).await, first);

            let (channel, events) = collecting_channel();
            run(owned, None, Duration::from_secs(120), &channel).await;
            assert!(canceling.unwrap().await.unwrap(), "{first:?}");
            assert!(!group_alive(leader));
            assert!(!process_alive(descendant));
            assert_eq!(
                events.lock().unwrap().last().map(String::as_str),
                Some(r#"{"type":"exit","exitCode":-1}"#)
            );
            assert_eq!(lifecycle.fence_receipts(), None, "{first:?}");
            assert!(lifecycle.state().running.is_empty());
        }
    }

    #[tokio::test]
    async fn stream_lifecycle_fence_keeps_the_first_stop_leg_with_its_origin_only() {
        let scratch = Scratch::new();
        let launch = |lifecycle: Arc<StreamLifecycle>, id: &'static str| {
            let mut cmd = platform::build_command(&long_tree(&scratch, id), None, None);
            async move { started(lifecycle.launch(lifecycle.admit(), id, &mut cmd).await) }
        };

        // A later stop's tree-only leg with its classified taskkill report,
        // first requested by app exit.
        let later_tree_stop = || {
            Some(
                Fence::stop_requested(
                    CleanupFailure::TreeUnconfirmed,
                    Some(TaskkillFailure::RequestedPidNotFound),
                )
                .requested_by(StopRequestSource::ApplicationExit),
            )
        };

        // The first stop's leg is recorded with its origin and survives a
        // later owner's outcome, a later stop's leg and taskkill failure, and
        // a cancellation timeout.
        let first = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        let (stop, later_stop, timeout) = (
            launch(first.clone(), "stop").await,
            launch(first.clone(), "later-stop").await,
            launch(first.clone(), "timeout").await,
        );
        assert_eq!(first.fence_receipts(), None);
        release_with(
            stop,
            Some(Fence::stop_requested(
                CleanupFailure::LeaderWaitFailed,
                Some(TaskkillFailure::NonzeroExit(NonZeroI32::new(1))),
            )),
        )
        .await;
        release(timeout, Some(FenceOrigin::OwnerTimeout)).await;
        release_with(later_stop, later_tree_stop()).await;
        first.fence_cancel_wait_timeout("timeout", 0);
        assert_eq!(origin(&first), Some(FenceOrigin::OwnerStopRequested));
        assert_eq!(cleanup(&first), Some(CleanupFailure::LeaderWaitFailed));
        assert_eq!(windows_taskkill(&first), None);
        // A later cancellation timeout never adds its owner's phase either,
        // nor a later stop its source.
        assert_eq!(owner_phase(&first), None);
        assert_eq!(stop_request_source(&first), None);

        // The first stop with taskkill's not-found exit, classified or not,
        // keeps its own first source; a later stop's report never replaces it.
        for (taskkill, source) in [
            (
                TaskkillFailure::RequestedPidNotFound,
                StopRequestSource::CancelIpc,
            ),
            (
                TaskkillFailure::NonzeroExit(Some(platform::TASKKILL_NOT_FOUND_EXIT)),
                StopRequestSource::DocumentInvalidation,
            ),
        ] {
            let not_found = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
            let (stop, later_stop) = (
                launch(not_found.clone(), "stop").await,
                launch(not_found.clone(), "later-stop").await,
            );
            release_with(
                stop,
                Some(
                    Fence::stop_requested(CleanupFailure::TreeUnconfirmed, Some(taskkill))
                        .requested_by(source),
                ),
            )
            .await;
            release_with(later_stop, later_tree_stop()).await;
            // Its own root report, never the later stop's classified one.
            assert_eq!(
                not_found
                    .fence_receipts()
                    .and_then(|receipts| receipts.windows_taskkill_root_report),
                FenceWindowsTaskkillReceipt::with_root_report(taskkill),
            );
            assert_eq!(
                stop_request_source(&not_found),
                Some(source),
                "{taskkill:?}"
            );
        }

        // The first tree-only stop keeps its own taskkill failure.
        let tree = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        let (stop, later_stop) = (
            launch(tree.clone(), "stop").await,
            launch(tree.clone(), "later-stop").await,
        );
        release_with(
            stop,
            Some(Fence::stop_requested(
                CleanupFailure::TreeUnconfirmed,
                Some(TaskkillFailure::NonzeroExit(None)),
            )),
        )
        .await;
        release_with(later_stop, later_tree_stop()).await;
        assert_eq!(cleanup(&tree), Some(CleanupFailure::TreeUnconfirmed));
        assert_eq!(
            windows_taskkill(&tree),
            Some(TaskkillFailure::NonzeroExit(None).into())
        );
        // Its codeless exit has no root report, and the later stop's
        // classified report never supplies one, nor its source.
        assert_eq!(
            tree.fence_receipts()
                .and_then(|receipts| receipts.windows_taskkill_root_report),
            None
        );
        assert_eq!(stop_request_source(&tree), None);

        // A later stop never backfills a leg or taskkill failure onto an
        // earlier origin: another owner's outcome, a stop released before
        // recording its outcome, or a cancellation wait timeout.
        for earlier in [
            FenceOrigin::OwnerTimeout,
            FenceOrigin::OwnerOutcomeMissing,
            FenceOrigin::CancelWaitTimeout,
        ] {
            let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
            let (fenced, stop) = (
                launch(lifecycle.clone(), "fenced").await,
                launch(lifecycle.clone(), "stop").await,
            );
            let timed_out = earlier == FenceOrigin::CancelWaitTimeout;
            if timed_out {
                // Its matched owner had not started `run`.
                lifecycle.fence_cancel_wait_timeout("fenced", fenced.completion.serial);
                release(fenced, None).await;
            } else {
                release(fenced, Some(earlier)).await;
            }
            release_with(stop, later_tree_stop()).await;
            assert_eq!(origin(&lifecycle), Some(earlier));
            assert_eq!(cleanup(&lifecycle), None, "{earlier:?}");
            assert_eq!(windows_taskkill(&lifecycle), None, "{earlier:?}");
            assert_eq!(stop_request_source(&lifecycle), None, "{earlier:?}");
            // Only the cancellation timeout records a phase: its own owner's,
            // unchanged by that owner's or a later stop's outcome.
            assert_eq!(
                owner_phase(&lifecycle),
                timed_out.then_some(CancelWaitOwnerPhase::OwnerPending),
                "{earlier:?}"
            );
        }
    }

    #[tokio::test]
    async fn stream_lifecycle_fence_keeps_only_its_first_stops_group_probe_and_source() {
        use GroupProbe::*;
        use StopRequestSource::*;
        let scratch = Scratch::new();
        let launch = |lifecycle: Arc<StreamLifecycle>, id: &'static str| {
            let mut cmd = platform::build_command(&long_tree(&scratch, id), None, None);
            async move { started(lifecycle.launch(lifecycle.admit(), id, &mut cmd).await) }
        };
        let probed = |probe, source| {
            Some(
                Fence::stop_requested_after(
                    CleanupFailure::TreeUnconfirmed,
                    Some(TreeStopFailure::GroupProbe(probe)),
                )
                .requested_by(source),
            )
        };
        let darwin_stop = |lifecycle: &StreamLifecycle| {
            lifecycle
                .fence_receipts()
                .and_then(|receipts| receipts.darwin_stop)
                .map(|receipt| (receipt.source, receipt.group_probe))
        };
        let macos = cfg!(target_os = "macos");

        // A later probed stop never replaces the first one's source or class.
        let first = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        let (stop, later) = (
            launch(first.clone(), "stop").await,
            launch(first.clone(), "later").await,
        );
        release_with(stop, probed(ProbeDenied, DocumentInvalidation)).await;
        release_with(later, probed(GroupVisible, CancelIpc)).await;
        assert_eq!(origin(&first), Some(FenceOrigin::OwnerStopRequested));
        assert_eq!(
            darwin_stop(&first),
            macos.then_some((DocumentInvalidation, ProbeDenied))
        );

        // Nor is it backfilled onto an earlier origin, including an owner
        // timeout's own tree-only leg.
        let timed_out = Fence::owner_timeout(GracefulKill {
            tree_stopped: false,
            leader: LeaderWait::Reaped,
            taskkill: None,
        });
        for earlier in [timed_out, Some(FenceOrigin::OwnerOutcomeMissing.into())] {
            let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
            let (fenced, stop) = (
                launch(lifecycle.clone(), "fenced").await,
                launch(lifecycle.clone(), "stop").await,
            );
            release_with(fenced, earlier).await;
            release_with(stop, probed(GroupVisible, ApplicationExit)).await;
            assert_eq!(
                origin(&lifecycle),
                earlier.map(|fence| fence.origin),
                "{earlier:?}"
            );
            assert_eq!(darwin_stop(&lifecycle), None, "{earlier:?}");
        }
    }

    #[tokio::test]
    async fn stream_lifecycle_owner_timeout_keeps_its_terminal_and_records_only_its_cleanup_leg() {
        // A real timeout whose existing cleanup confirmed: the same tree stop,
        // terminal message and no fence.
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        let mut cmd = fixed_shell(&long_tree(&scratch, "timed-out"));
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "timed-out", &mut cmd)
                .await,
        );
        let leader = owned.child.id().unwrap();
        let descendant: libc::pid_t = wait_for_file(&scratch.path("descendant"))
            .await
            .parse()
            .unwrap();
        let (channel, events) = collecting_channel();
        run(owned, None, Duration::from_millis(300), &channel).await;
        assert!(!group_alive(leader));
        assert!(!process_alive(descendant));
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"error","message":"Command timed out after 300ms"}"#)
        );
        assert_eq!(lifecycle.fence_receipts(), None);
        assert!(lifecycle.state().running.is_empty());

        // An unconfirmed timeout's leg rides beside its own origin with only
        // its own taskkill failure, if any, never a source, and a later stop's
        // never replaces or supplements either.
        for taskkill in [
            None,
            Some(TaskkillFailure::NonzeroExit(NonZeroI32::new(255))),
        ] {
            let fenced = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
            let mut owners = Vec::new();
            for id in ["timeout", "later-stop"] {
                let mut cmd = fixed_shell(&long_tree(&scratch, id));
                owners.push(started(fenced.launch(fenced.admit(), id, &mut cmd).await));
            }
            let mut owners = owners.into_iter();
            release_with(
                owners.next().unwrap(),
                Fence::owner_timeout(GracefulKill {
                    tree_stopped: false,
                    leader: LeaderWait::Reaped,
                    taskkill,
                }),
            )
            .await;
            release_with(
                owners.next().unwrap(),
                Some(
                    Fence::stop_requested(
                        CleanupFailure::TreeUnconfirmed,
                        Some(TaskkillFailure::RequestedPidNotFound),
                    )
                    .requested_by(StopRequestSource::CancelIpc),
                ),
            )
            .await;
            let receipts = fenced
                .fence_receipts()
                .expect("the timeout fenced admission");
            assert_eq!(
                serde_json::to_value(receipts.origin).unwrap(),
                serde_json::json!({ "version": 1, "origin": "owner_timeout" })
            );
            assert_eq!(
                serde_json::to_value(receipts.cleanup).unwrap(),
                serde_json::json!({ "version": 1, "failure": "tree_unconfirmed" })
            );
            assert_eq!(
                receipts.windows_taskkill,
                taskkill.map(FenceWindowsTaskkillReceipt::from),
                "{taskkill:?}"
            );
            assert_eq!(
                receipts.windows_taskkill_root_report,
                taskkill.and_then(FenceWindowsTaskkillReceipt::with_root_report),
                "{taskkill:?}"
            );
            assert_eq!(receipts.stop_request_source, None, "{taskkill:?}");
            assert_eq!(receipts.cancel_wait_owner_phase, None, "{taskkill:?}");
        }
    }

    #[tokio::test]
    async fn stream_lifecycle_fence_keeps_its_first_origin_and_confirmed_owners_record_none() {
        let scratch = Scratch::new();
        let gate = private_gate();
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(gate));
        let mut owners = Vec::new();
        for id in ["confirmed", "first", "second"] {
            let mut cmd = platform::build_command(&long_tree(&scratch, id), None, None);
            owners.push(started(
                lifecycle.launch(lifecycle.admit(), id, &mut cmd).await,
            ));
        }
        let mut owners = owners.into_iter();

        // A confirmed owner records nothing and leaves admission and updates open.
        release(owners.next().unwrap(), None).await;
        assert_eq!(origin(&lifecycle), None);
        assert!(gate.install().is_ok(), "a confirmed owner fenced updates");
        let mut cmd = platform::build_command("true", None, None);
        let (channel, _) = collecting_channel();
        run(
            started(
                lifecycle
                    .launch(lifecycle.admit(), "admitted", &mut cmd)
                    .await,
            ),
            None,
            Duration::from_secs(30),
            &channel,
        )
        .await;
        assert_eq!(origin(&lifecycle), None);

        // The first unconfirmed outcome wins over a later owner and a later
        // cancellation wait timeout, and is never cleared.
        release(owners.next().unwrap(), Some(FenceOrigin::OwnerTimeout)).await;
        release(
            owners.next().unwrap(),
            Some(FenceOrigin::OwnerDeliveryFailed),
        )
        .await;
        lifecycle.fence_cancel_wait_timeout("second", 0);
        assert_eq!(origin(&lifecycle), Some(FenceOrigin::OwnerTimeout));
        assert_eq!(owner_phase(&lifecycle), None);
        assert!(gate.install().is_err(), "updates must stay fenced");
        let mut cmd = platform::build_command("true", None, None);
        assert_eq!(
            lifecycle
                .launch(lifecycle.admit(), "later", &mut cmd)
                .await
                .err()
                .as_deref(),
            Some(STOP_UNCONFIRMED)
        );
        assert_eq!(origin(&lifecycle), Some(FenceOrigin::OwnerTimeout));
        assert!(lifecycle.state().running.is_empty());
    }

    #[tokio::test]
    async fn stream_lifecycle_cancel_wait_timeout_keeps_its_origin_after_the_owner_confirms() {
        let scratch = Scratch::new();
        let gate = private_gate();
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(gate));
        let mut cmd = platform::build_command(&long_tree(&scratch, "held"), None, None);
        // Launched but not yet run: its owner cannot answer the stop request.
        let owned = started(lifecycle.launch(lifecycle.admit(), "held", &mut cmd).await);
        let leader = owned.child.id().unwrap();
        wait_for_file(&scratch.path("runs")).await;

        // Waits the full existing CANCEL_WAIT before reporting unconfirmed.
        assert!(!lifecycle.cancel("held").await);
        assert_eq!(origin(&lifecycle), Some(FenceOrigin::CancelWaitTimeout));
        // Recorded from the owner the cancellation matched, at that instant.
        assert_eq!(
            owner_phase(&lifecycle),
            Some(CancelWaitOwnerPhase::OwnerPending)
        );

        // The owner then confirms its stop; the fence, its origin and phase
        // remain: a later owner result never backfills the timeout's phase.
        let (channel, _) = collecting_channel();
        run(owned, None, Duration::from_secs(120), &channel).await;
        assert!(!group_alive(leader));
        assert!(lifecycle.state().running.is_empty());
        assert_eq!(origin(&lifecycle), Some(FenceOrigin::CancelWaitTimeout));
        assert_eq!(
            owner_phase(&lifecycle),
            Some(CancelWaitOwnerPhase::OwnerPending)
        );
        let mut cmd = platform::build_command("true", None, None);
        assert_eq!(
            lifecycle
                .launch(lifecycle.admit(), "after", &mut cmd)
                .await
                .err()
                .as_deref(),
            Some(STOP_UNCONFIRMED)
        );
        assert!(gate.install().is_err(), "updates must stay fenced");
    }

    /// The terminal callback acknowledges entry and waits for the test to
    /// release it. Dropping the release sender also lets the owner continue.
    fn held_terminal_channel() -> (
        Channel<StreamEvent>,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (entered, entry) = std::sync::mpsc::sync_channel(1);
        let (release, released) = std::sync::mpsc::sync_channel(1);
        let released = Mutex::new(released);
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if json.contains(r#""type":"exit""#) || json.contains(r#""type":"error""#) {
                    let _ = entered.try_send(());
                    let _ = released
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(10));
                }
            }
            Ok(())
        });
        (channel, entry, release)
    }

    /// The timeout's fence records the step its matched owner had published
    /// when that fence was inserted, with each later outcome or timeout
    /// leaving it unchanged. Each case is its own lifecycle: the first fence
    /// wins for the life of the process.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stream_lifecycle_cancel_wait_timeout_records_its_matched_owner_phase_when_it_wins() {
        use super::tests::reaches;
        use CancelWaitOwnerPhase::*;
        let scratch = Scratch::new();
        let fresh = || Arc::new(StreamLifecycle::with_update_gate(private_gate()));

        // Streaming, before the owner observed any stop request.
        let lifecycle = fresh();
        let mut cmd = platform::build_command(&long_tree(&scratch, "streaming"), None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "streaming", &mut cmd)
                .await,
        );
        let (serial, phase, leader) = (
            owned.completion.serial,
            owned.phase.clone(),
            owned.child.id().unwrap(),
        );
        let (channel, _) = collecting_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(120), &channel).await });
        wait_for_file(&scratch.path("runs")).await;
        reaches(&phase, OwnerStreaming).await;
        lifecycle.fence_cancel_wait_timeout("streaming", serial);
        assert_eq!(origin(&lifecycle), Some(FenceOrigin::CancelWaitTimeout));
        assert_eq!(owner_phase(&lifecycle), Some(OwnerStreaming));
        // The owner still answers a later stop; neither its confirmed cleanup
        // nor a later timeout for it changes the recorded phase.
        assert!(lifecycle.cancel("streaming").await);
        owner.await.unwrap();
        assert!(!group_alive(leader));
        lifecycle.fence_cancel_wait_timeout("streaming", serial);
        assert_eq!(owner_phase(&lifecycle), Some(OwnerStreaming));

        // A stop request's cleanup whose leader was reaped while a TERM-ignoring
        // member kept the tree check outstanding.
        let lifecycle = fresh();
        let stubborn = format!(
            "(trap '' TERM; printf 'ready\\n' > {}; while :; do sleep 0.05; done) & wait",
            quoted(&scratch.path("ready"))
        );
        let mut cmd = platform::build_command(&stubborn, None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "stubborn", &mut cmd)
                .await,
        );
        let (serial, phase, leader) = (
            owned.completion.serial,
            owned.phase.clone(),
            owned.child.id().unwrap(),
        );
        let (channel, _) = collecting_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(120), &channel).await });
        wait_for_file(&scratch.path("ready")).await;
        reaches(&phase, OwnerStreaming).await;
        let canceling = tokio::spawn({
            let lifecycle = lifecycle.clone();
            async move { lifecycle.cancel("stubborn").await }
        });
        reaches(&phase, StopCleanupTreePending).await;
        lifecycle.fence_cancel_wait_timeout("stubborn", serial);
        assert_eq!(owner_phase(&lifecycle), Some(StopCleanupTreePending));
        // Escalation then stops the member; the confirmed result never
        // replaces the phase recorded while the check was outstanding.
        assert!(canceling.await.unwrap());
        owner.await.unwrap();
        assert!(!group_alive(leader));
        assert_eq!(owner_phase(&lifecycle), Some(StopCleanupTreePending));

        // Delivering its terminal event, after its cleanup and before release.
        let lifecycle = fresh();
        let mut cmd = platform::build_command("exit 0", None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "delivering", &mut cmd)
                .await,
        );
        let serial = owned.completion.serial;
        let (channel, entered, allow_delivery) = held_terminal_channel();
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(30), &channel).await });
        tokio::task::spawn_blocking(move || entered.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .unwrap();
        lifecycle.fence_cancel_wait_timeout("delivering", serial);
        assert_eq!(owner_phase(&lifecycle), Some(TerminalDelivery));
        allow_delivery.send(()).unwrap();
        owner.await.unwrap();
        assert!(lifecycle.state().running.is_empty());
        assert_eq!(owner_phase(&lifecycle), Some(TerminalDelivery));

        // Released: the matched owner's registration is gone, even though a
        // later owner now holds the same command ID under another serial.
        let lifecycle = fresh();
        let mut cmd = platform::build_command("exit 0", None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "reused", &mut cmd)
                .await,
        );
        let serial = owned.completion.serial;
        let (channel, _) = collecting_channel();
        run(owned, None, Duration::from_secs(30), &channel).await;
        let mut cmd = platform::build_command("exit 0", None, None);
        let later = started(
            lifecycle
                .launch(lifecycle.admit(), "reused", &mut cmd)
                .await,
        );
        assert_ne!(later.completion.serial, serial);
        lifecycle.fence_cancel_wait_timeout("reused", serial);
        assert_eq!(owner_phase(&lifecycle), Some(Released));
        release(later, None).await;
        assert_eq!(owner_phase(&lifecycle), Some(Released));
    }

    #[tokio::test]
    async fn stream_lifecycle_recorded_origin_keeps_admission_priority() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        let stale = lifecycle.admit();
        let mut cmd = platform::build_command(&long_tree(&scratch, "old"), None, None);
        let owned = started(lifecycle.launch(stale, "old", &mut cmd).await);
        wait_for_file(&scratch.path("runs")).await;
        release(owned, Some(FenceOrigin::OwnerStopRequested)).await;
        assert!(lifecycle.cancel("tombstoned").await);
        lifecycle.invalidate();

        let marker = scratch.path("ran");
        let command = format!("printf 'ran\\n' >> {}", quoted(&marker));
        let attempt = |id: &'static str, admission: Admission| {
            let lifecycle = lifecycle.clone();
            let mut cmd = platform::build_command(&command, None, None);
            async move { lifecycle.launch(admission, id, &mut cmd).await }
        };
        // Cancellation, then page replacement, then the fence, as before.
        assert!(matches!(
            attempt("tombstoned", stale).await,
            Ok(Launch::Canceled)
        ));
        assert_eq!(
            attempt("stale", stale).await.err().as_deref(),
            Some(PAGE_REPLACED)
        );
        assert_eq!(
            attempt("fresh", lifecycle.admit()).await.err().as_deref(),
            Some(STOP_UNCONFIRMED)
        );
        assert_eq!(origin(&lifecycle), Some(FenceOrigin::OwnerStopRequested));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!marker.exists(), "a fenced command ran");
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
            let (_, cleanups) = exiting.invalidate_for_exit();
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

    #[tokio::test]
    async fn stream_lifecycle_preserves_utf8_across_reads() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        let (stdout_gate, stderr_gate) = (scratch.path("stdout-gate"), scratch.path("stderr-gate"));
        // The shell writes the first two bytes of a euro sign, then blocks until
        // the test has received the printable prefix, so the continuation byte
        // can only arrive in a later read. Stderr completes its own scalar while
        // stdout's is pending, and ends on a truncated scalar at EOF.
        let command = format!(
            "printf 'out:\\342\\202'; while [ ! -f {stdout_gate} ]; do sleep 0.02; done; \
             printf 'err:\\342\\202\\254\\n' >&2; \
             while [ ! -f {stderr_gate} ]; do sleep 0.02; done; \
             printf '\\254\\n'; printf 'tail:\\342\\202' >&2",
            stdout_gate = quoted(&stdout_gate),
            stderr_gate = quoted(&stderr_gate),
        );
        let mut cmd = platform::build_command(&command, None, None);
        let owned = started(lifecycle.launch(lifecycle.admit(), "utf8", &mut cmd).await);
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = sender.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let owner =
            tokio::spawn(async move { run(owned, None, Duration::from_secs(30), &channel).await });

        let (mut stdout, mut stderr) = (String::new(), String::new());
        let (mut stdout_released, mut stderr_released) = (false, false);
        let exit = loop {
            let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .expect("no stream event arrived")
                .expect("the channel closed before the exit event");
            let target = match event["type"].as_str() {
                Some("stdout") => &mut stdout,
                Some("stderr") => &mut stderr,
                _ => break event,
            };
            let data = event["data"].as_str().unwrap();
            assert!(!data.is_empty(), "empty data event: {event}");
            target.push_str(data);
            if !stdout_released && stdout.contains("out:") {
                stdout_released = true;
                std::fs::write(&stdout_gate, b"go").unwrap();
            }
            if stdout_released
                && !stderr_released
                && stderr
                    .split_once("err:")
                    .is_some_and(|(_, line)| line.contains('\n'))
            {
                stderr_released = true;
                std::fs::write(&stderr_gate, b"go").unwrap();
            }
        };
        assert_eq!(exit, serde_json::json!({ "type": "exit", "exitCode": 0 }));
        assert!(stdout.ends_with("out:€\n"), "stdout: {stdout:?}");
        // The truncated stderr scalar is reported once, before the exit event.
        assert!(
            stderr.ends_with("err:€\ntail:\u{FFFD}"),
            "stderr: {stderr:?}"
        );
        owner.await.unwrap();
        assert!(events.recv().await.is_none(), "an event followed exit");
    }

    #[tokio::test]
    async fn stream_lifecycle_normal_completion_keeps_an_intentional_background_job() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::default());
        // The established detached pattern: redirect the job's output so the
        // shell can exit and the command completes.
        let command = format!(
            "sleep 60 > /dev/null 2>&1 & echo $! > {}",
            quoted(&scratch.path("background"))
        );
        let mut cmd = platform::build_command(&command, None, None);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "detached", &mut cmd)
                .await,
        );
        let leader = owned.child.id().unwrap();
        let (channel, events) = collecting_channel();
        run(owned, None, Duration::from_secs(30), &channel).await;
        let background: libc::pid_t = std::fs::read_to_string(scratch.path("background"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"exit","exitCode":0}"#)
        );
        // Ownership ended with the shell; the job outlives it in that group.
        assert!(lifecycle.state().running.is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            process_alive(background),
            "normal completion killed the job"
        );
        assert!(group_alive(leader));

        // Later page replacement and app exit do not reach it either.
        let (_, cleanups) = lifecycle.invalidate();
        assert!(cleanups.is_empty());
        assert!(process_alive(background));

        // Clean up exactly the job this test started.
        assert_eq!(unsafe { libc::kill(background, libc::SIGKILL) }, 0);
    }
}

/// Real Windows processes under each command's Job. Fixtures use fixed
/// System32 `cmd.exe` and Windows PowerShell, never the user's shell, and each
/// case has its own lifecycle, update gate and scratch directory.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::tests::{collecting_channel, private_gate, started, Scratch};
    use super::*;
    use base64::Engine;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::Instant;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// WaitForSingleObject's `WAIT_OBJECT_0`: the process exited.
    const EXITED: u32 = 0;
    /// Its `WAIT_TIMEOUT`: the process was still running at the deadline.
    const RUNNING: u32 = 0x102;

    fn system32(name: &str) -> PathBuf {
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
            .join("System32")
            .join(name)
    }

    fn powershell() -> PathBuf {
        system32("WindowsPowerShell\\v1.0\\powershell.exe")
    }

    /// `script` as `-EncodedCommand` takes it, which needs no quoting.
    fn encoded(script: &str) -> String {
        let utf16le: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        base64::engine::general_purpose::STANDARD.encode(utf16le)
    }

    fn literal(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "''"))
    }

    /// A descendant that records its own PID, optionally reports on its
    /// stdout, then outlives any test that does not stop it.
    fn sleeper(pid_file: &Path, announce: bool) -> String {
        let announce = if announce {
            "[Console]::Out.WriteLine('descendant ready'); "
        } else {
            ""
        };
        format!(
            "[IO.File]::WriteAllText({}, \"$PID`n\"); {announce}Start-Sleep -Seconds 120",
            literal(pid_file)
        )
    }

    fn piped(mut cmd: Command) -> Command {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// The released failure's shape: `cmd` starts a PowerShell descendant
    /// that inherits its output pipes, then exits at once, leaving only that
    /// descendant holding the stream open.
    fn orphaning_launcher(pid_file: &Path) -> Command {
        let mut cmd = Command::new(system32("cmd.exe"));
        cmd.raw_arg(format!(
            "/D /C start \"\" /b \"{}\" -NoProfile -NonInteractive -EncodedCommand {}",
            powershell().display(),
            encoded(&sleeper(pid_file, true))
        ));
        piped(cmd)
    }

    /// A launcher that starts the same descendant without its pipes, as an
    /// intentional background job, then exits.
    fn detaching_launcher(pid_file: &Path) -> Command {
        let start = format!(
            "Start-Process -FilePath {} -WindowStyle Hidden -ArgumentList \
             '-NoProfile','-NonInteractive','-EncodedCommand','{}'",
            literal(&powershell()),
            encoded(&sleeper(pid_file, false))
        );
        let script = encoded(&start);
        let mut cmd = Command::new(powershell());
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            script.as_str(),
        ]);
        piped(cmd)
    }

    fn exiting() -> Command {
        let mut cmd = Command::new(system32("cmd.exe"));
        cmd.raw_arg("/D /C exit 0");
        piped(cmd)
    }

    /// A handle pinning the process `pid` names now. Not yet proven to be a
    /// fixture, so dropping it only closes it and never terminates anything.
    fn pin(pid: u32) -> OwnedHandle {
        let access = PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;
        let handle =
            unsafe { OpenProcess(access, false, pid) }.expect("the fixture must be running");
        // SAFETY: a successful call returns a new process handle owned here.
        unsafe { OwnedHandle::from_raw_handle(handle.0) }
    }

    /// A test-owned handle to a fixture process, independent of the
    /// implementation's Job. Built only from a pinned handle proven a member
    /// of the test command's private Job, so dropping it, which terminates
    /// exactly that process if it still runs, can never reach another process.
    struct Fixture(OwnedHandle);

    impl Fixture {
        /// Panics, closing `pinned` without terminating it, unless the pinned
        /// process is a member of `owned`'s Job.
        fn member_of(owned: &OwnedCommand, pinned: OwnedHandle) -> Self {
            assert!(
                owned.tree.contains(HANDLE(pinned.as_raw_handle())),
                "the descendant is outside its command's Job"
            );
            Self(pinned)
        }

        fn handle(&self) -> HANDLE {
            HANDLE(self.0.as_raw_handle())
        }

        /// `EXITED` once the process exited within `timeout`, else `RUNNING`.
        fn wait(&self, timeout: Duration) -> u32 {
            // SAFETY: the handle is open with SYNCHRONIZE access.
            unsafe { WaitForSingleObject(self.handle(), timeout.as_millis() as u32) }.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // SAFETY: the handle is open with PROCESS_TERMINATE access.
            let _ = unsafe { TerminateProcess(self.handle(), 1) };
        }
    }

    async fn recorded_pid(path: &Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(content) = std::fs::read_to_string(path) {
                if content.ends_with('\n') {
                    return content.trim().parse().unwrap();
                }
            }
            assert!(Instant::now() < deadline, "the descendant never started");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The descendant's own handle, proven a live member of `owned`'s Job. The
    /// handle is opened first and pins its PID, so a recycled PID could not
    /// pass the membership check, and only then may it terminate anything.
    async fn tracked_descendant(owned: &OwnedCommand, pid_file: &Path) -> Fixture {
        let descendant = Fixture::member_of(owned, pin(recorded_pid(pid_file).await));
        assert_eq!(descendant.wait(Duration::ZERO), RUNNING);
        descendant
    }

    /// Wait, without reaping it, for the shell `child` still owns to exit.
    fn wait_for_launcher_exit(child: &Child) {
        let process = HANDLE(child.raw_handle().expect("the shell is unreaped"));
        // SAFETY: `child` keeps its process handle open until it is reaped.
        let waited = unsafe { WaitForSingleObject(process, 60_000) }.0;
        assert_eq!(waited, EXITED, "the launcher never exited");
    }

    /// Confirmed cleanup leaves admission open: the next command runs.
    async fn next_command_runs(lifecycle: &Arc<StreamLifecycle>) {
        let mut cmd = exiting();
        let owned = started(lifecycle.launch(lifecycle.admit(), "next", &mut cmd).await);
        let (channel, events) = collecting_channel();
        run(owned, None, Duration::from_secs(60), &channel).await;
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"exit","exitCode":0}"#)
        );
    }

    #[derive(Clone, Copy, Debug)]
    enum Stop {
        CancelIpc,
        DocumentInvalidation,
        Timeout,
        DeliveryFailed,
    }

    /// The released bug: once the launcher exited, its stop could not reach
    /// the descendant still holding the stream, and the next command was
    /// fenced. Every owner stop now ends it through the command's Job.
    #[tokio::test]
    async fn stream_lifecycle_windows_every_stop_ends_descendants_of_an_exited_launcher() {
        for stop in [
            Stop::CancelIpc,
            Stop::DocumentInvalidation,
            Stop::Timeout,
            Stop::DeliveryFailed,
        ] {
            let scratch = Scratch::new();
            let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
            let pid_file = scratch.path("descendant");
            let mut cmd = orphaning_launcher(&pid_file);
            let owned = started(
                lifecycle
                    .launch(lifecycle.admit(), "orphaning", &mut cmd)
                    .await,
            );
            let descendant = tracked_descendant(&owned, &pid_file).await;
            wait_for_launcher_exit(&owned.child);

            let (channel, events) = collecting_channel();
            match stop {
                Stop::CancelIpc => {
                    let owner = tokio::spawn(async move {
                        run(owned, None, Duration::from_secs(120), &channel).await
                    });
                    assert!(lifecycle.cancel("orphaning").await);
                    owner.await.unwrap();
                    // Still the exit event, never the unconfirmed error.
                    let last = events.lock().unwrap().last().cloned().unwrap_or_default();
                    assert!(last.starts_with(r#"{"type":"exit""#), "{last}");
                }
                Stop::DocumentInvalidation => {
                    let owner = tokio::spawn(async move {
                        run(owned, None, Duration::from_secs(120), &channel).await
                    });
                    let (_, cleanups) = lifecycle.invalidate();
                    assert_eq!(cleanups.len(), 1);
                    assert!(resolved(cleanups).await);
                    owner.await.unwrap();
                }
                Stop::Timeout => {
                    run(owned, None, Duration::from_millis(500), &channel).await;
                    assert_eq!(
                        events.lock().unwrap().last().map(String::as_str),
                        Some(r#"{"type":"error","message":"Command timed out after 500ms"}"#)
                    );
                }
                // The descendant's own output is the first delivery to fail.
                Stop::DeliveryFailed => {
                    let closed: Channel<StreamEvent> =
                        Channel::new(|_| Err(std::io::Error::other("receiver closed").into()));
                    run(owned, None, Duration::from_secs(120), &closed).await;
                }
            }
            assert_eq!(
                descendant.wait(Duration::from_secs(10)),
                EXITED,
                "{stop:?}: the descendant outlived its stop"
            );
            assert_eq!(lifecycle.fence_receipts(), None, "{stop:?}");
            assert!(lifecycle.state().running.is_empty(), "{stop:?}");
            next_command_runs(&lifecycle).await;
        }
    }

    /// A stop that finds the shell and every member already exited confirms
    /// at once: the empty Job is never a false fence, by a stop request's
    /// cleanup or an owner's own cleanup after a timeout or process error.
    #[tokio::test]
    async fn stream_lifecycle_windows_stop_after_natural_exit_confirms_the_empty_job() {
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        for stop_request in [true, false] {
            let mut cmd = exiting();
            let owned = started(
                lifecycle
                    .launch(lifecycle.admit(), "exited", &mut cmd)
                    .await,
            );
            wait_for_launcher_exit(&owned.child);
            // The Job's count can lag its last member's exit.
            let deadline = Instant::now() + Duration::from_secs(10);
            while owned.tree.active() != Some(0) {
                assert!(Instant::now() < deadline, "the Job never emptied");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let OwnedCommand {
                mut child,
                tree,
                mut completion,
                ..
            } = owned;
            completion.unconfirmed = if stop_request {
                let (fence, status) = terminate_owned(&mut child, &tree, None).await;
                // The shell's own exit, not a stop's.
                assert_eq!(status.and_then(|status| status.code()), Some(0));
                fence
            } else {
                Fence::owner_timeout(graceful_kill_owned(&mut child, &tree).await)
            };
            assert_eq!(completion.unconfirmed, None, "stop request: {stop_request}");
        }
        assert_eq!(lifecycle.fence_receipts(), None);
        next_command_runs(&lifecycle).await;
    }

    #[tokio::test]
    async fn stream_lifecycle_windows_normal_completion_keeps_an_intentional_background_job() {
        let scratch = Scratch::new();
        let lifecycle = Arc::new(StreamLifecycle::with_update_gate(private_gate()));
        let pid_file = scratch.path("background");
        let mut cmd = detaching_launcher(&pid_file);
        let owned = started(
            lifecycle
                .launch(lifecycle.admit(), "detached", &mut cmd)
                .await,
        );
        // A member of the command's Job, like any descendant.
        let background = tracked_descendant(&owned, &pid_file).await;
        let (channel, events) = collecting_channel();
        run(owned, None, Duration::from_secs(60), &channel).await;
        assert_eq!(
            events.lock().unwrap().last().map(String::as_str),
            Some(r#"{"type":"exit","exitCode":0}"#)
        );
        assert!(lifecycle.state().running.is_empty());
        assert_eq!(lifecycle.fence_receipts(), None);
        // Ownership ended with the shell; closing its Job handle stopped
        // nothing, and later page replacement does not reach the job either.
        assert_eq!(
            background.wait(Duration::from_millis(200)),
            RUNNING,
            "normal completion killed the job"
        );
        let (_, cleanups) = lifecycle.invalidate();
        assert!(cleanups.is_empty());
        assert_eq!(background.wait(Duration::ZERO), RUNNING);
        // Dropping `background` ends exactly the job this test started.
    }
}
