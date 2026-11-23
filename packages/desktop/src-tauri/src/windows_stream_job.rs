//! A private Win32 Job Object for each streamed Windows command.
//!
//! The shell is created suspended, assigned to a new unnamed Job whose handle
//! is never inheritable, and only then resumed, so it and everything it starts
//! are members before any of its code runs. A stop terminates that Job and
//! confirms through the Job's own accounting that no member remains. Neither
//! step needs the shell to still be running or any PID, so a launcher that
//! already exited can no longer hide its descendants.
//!
//! The Job sets no limits. Without kill-on-close, dropping its handle after a
//! normal exit leaves intentional background work running, as before. Without
//! a breakaway limit, members cannot leave it: a member that asks for
//! `CREATE_BREAKAWAY_FROM_JOB` fails to start that child instead.

use std::mem::{offset_of, size_of};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::Duration;

use tokio::process::{Child, Command};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    QueryInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};
use windows::Win32::System::Threading::{
    GetProcessId, GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

use crate::stream_lifecycle::{SpawnFailure, REAP_TIMEOUT};

/// Bounds a stop's confirmation that the Job has no active member.
const CONFIRM_WAIT: Duration = Duration::from_secs(2);
/// A member's exit can be observed before the Job's count drops, so the count
/// is polled rather than read once.
const CONFIRM_POLL: Duration = Duration::from_millis(10);
/// The exit code `taskkill /F` gave a stopped shell, kept for its exit event.
const STOPPED_EXIT_CODE: u32 = 1;

/// Take ownership of a handle a Win32 call just returned.
///
/// # Safety
/// `handle` must be open, valid and owned by no one else.
unsafe fn adopt(handle: HANDLE) -> OwnedHandle {
    unsafe { OwnedHandle::from_raw_handle(handle.0) }
}

/// Borrow an owned handle for one Win32 call; the owner outlives that call.
fn borrowed(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

/// One streamed command's Job. Dropping it only closes this handle.
pub(crate) struct StreamJob(OwnedHandle);

impl StreamJob {
    fn create() -> windows::core::Result<Self> {
        // Unnamed, so no other process can open it by name, and with default
        // security attributes, so the command never inherits its handle.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }?;
        // SAFETY: a successful call returns a new open handle owned here.
        Ok(Self(unsafe { adopt(job) }))
    }

    fn handle(&self) -> HANDLE {
        borrowed(&self.0)
    }

    /// The Job's current count of active members, or None if unreadable.
    fn active_processes(&self) -> Option<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: `info` is a writable buffer of exactly the size passed for
        // this information class, and the Job handle is open.
        unsafe {
            QueryInformationJobObject(
                Some(self.handle()),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        }
        .ok()?;
        Some(info.ActiveProcesses)
    }

    /// Terminate every member, then confirm within `CONFIRM_WAIT` that none
    /// remains active. Only the Job's own count of zero confirms: a successful
    /// terminate call only requests termination, and a failed one is not
    /// decisive either. A Job whose members all exited already confirms at
    /// once. Callers still require the shell's own reap before releasing.
    pub(crate) async fn terminate(&self) -> bool {
        // SAFETY: the Job handle is open.
        let _ = unsafe { TerminateJobObject(self.handle(), STOPPED_EXIT_CODE) };
        let deadline = tokio::time::Instant::now() + CONFIRM_WAIT;
        loop {
            match self.active_processes() {
                Some(0) => return true,
                Some(_) => {}
                None => return false,
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(CONFIRM_POLL).await;
        }
    }

    /// Whether `process` is a member of this Job.
    #[cfg(test)]
    pub(crate) fn contains(&self, process: HANDLE) -> bool {
        use windows::Win32::System::JobObjects::IsProcessInJob;
        let mut member = Default::default();
        // SAFETY: both handles are open, and `member` is writable.
        unsafe { IsProcessInJob(process, Some(self.handle()), &mut member) }
            .expect("membership query failed");
        member.as_bool()
    }

    /// The Job's current count of active members.
    #[cfg(test)]
    pub(crate) fn active(&self) -> Option<u32> {
        self.active_processes()
    }
}

/// A launch that created its shell but could not prove it starts tracked.
pub(crate) struct Unproven {
    child: Child,
    /// Set only once the shell was assigned to it.
    job: Option<StreamJob>,
    /// The initial thread's suspension was not exactly the one this launch
    /// created, so the shell may have run before it joined the Job, or
    /// something else holds it.
    unexpected_resume: bool,
}

impl Unproven {
    /// Never provable, whatever its cleanup confirms.
    pub(crate) fn may_have_run(&self) -> bool {
        self.unexpected_resume
    }

    /// Stop exactly this shell, through its Job once assigned and through its
    /// own process handle before, never a PID, then reap it within the
    /// existing bounds. True only when the stop confirmed, the shell was
    /// reaped and it never could have run outside the Job.
    pub(crate) async fn clean_up(self) -> bool {
        let Self {
            mut child,
            job,
            unexpected_resume,
        } = self;
        if job.is_none() {
            // Never assigned, so never resumed: it started nothing, and its
            // reap below is the whole proof.
            let _ = child.start_kill();
        }
        let stopped = async {
            match &job {
                Some(job) => job.terminate().await,
                None => true,
            }
        };
        let (stopped, waited) =
            tokio::join!(stopped, tokio::time::timeout(REAP_TIMEOUT, child.wait()));
        stopped && matches!(waited, Ok(Ok(_))) && !unexpected_resume
    }
}

/// Spawn `cmd` suspended, assign it to a new private Job, then resume its one
/// initial thread exactly once. `cmd` keeps its program, arguments, directory,
/// environment and stdio; its creation flags are exactly the
/// `CREATE_NO_WINDOW` every streamed command has, plus `CREATE_SUSPENDED`.
pub(crate) fn spawn(cmd: &mut Command) -> Result<(Child, StreamJob), SpawnFailure> {
    // Created first, so its failure never starts a process.
    let job = StreamJob::create()
        .map_err(|error| SpawnFailure::NotStarted(format!("Failed to spawn: {error}")))?;
    cmd.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    let child = cmd
        .spawn()
        .map_err(|e| SpawnFailure::NotStarted(format!("Failed to spawn: {}", e)))?;
    let unproven = |child, job, unexpected_resume| {
        SpawnFailure::Unproven(Unproven {
            child,
            job,
            unexpected_resume,
        })
    };
    // `child` owns the process handle until Tokio reaps it, which needs a wait
    // this function never starts. The handle, and the PID it pins against
    // reuse, therefore stay valid through every check below.
    let Some(process) = child.raw_handle().map(HANDLE) else {
        return Err(unproven(child, None, false));
    };
    // SAFETY: `process` is the open handle `child` owns, as above.
    if unsafe { AssignProcessToJobObject(job.handle(), process) }.is_err() {
        return Err(unproven(child, None, false));
    }
    match resume_initial_thread(process) {
        Resume::Once => Ok((child, job)),
        Resume::NotResumed => Err(unproven(child, Some(job), false)),
        Resume::Unexpected => Err(unproven(child, Some(job), true)),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Resume {
    Once,
    NotResumed,
    Unexpected,
}

/// Resume the pinned process's one initial thread exactly once.
fn resume_initial_thread(process: HANDLE) -> Resume {
    // SAFETY: `process` stays open through this call (see `spawn`).
    let pid = unsafe { GetProcessId(process) };
    let Some(thread) = (pid != 0).then(|| initial_thread(pid)).flatten() else {
        return Resume::NotResumed;
    };
    // SAFETY: `thread` is open with THREAD_SUSPEND_RESUME access.
    resumed(unsafe { ResumeThread(borrowed(&thread)) })
}

/// Classify ResumeThread's previous suspend count. Exactly one is the
/// creation suspension. Failure leaves the count unchanged, so the thread
/// never ran. Zero means it was already running, possibly before it joined
/// the Job; more means a suspension this launch cannot account for.
fn resumed(previous: u32) -> Resume {
    match previous {
        1 => Resume::Once,
        u32::MAX => Resume::NotResumed,
        _ => Resume::Unexpected,
    }
}

/// The pinned process's only thread, opened and validated, or None.
///
/// The Toolhelp snapshot only names thread IDs at one instant; it proves
/// neither ownership nor Job membership. The opened handle pins the thread,
/// and that thread's own process ID proves it belongs to `pid`, which the
/// caller's process handle pins. Membership comes only from the earlier
/// successful assignment.
fn initial_thread(pid: u32) -> Option<OwnedHandle> {
    // SAFETY: a successful call returns a new snapshot handle owned here.
    let snapshot = unsafe { adopt(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).ok()?) };
    let full = size_of::<THREADENTRY32>() as u32;
    let owner_end = (offset_of!(THREADENTRY32, th32OwnerProcessID) + size_of::<u32>()) as u32;
    let mut entry = THREADENTRY32 {
        dwSize: full,
        ..Default::default()
    };
    let mut found = None;
    // SAFETY: `entry` is writable and its dwSize names its full size.
    let mut listed = unsafe { Thread32First(borrowed(&snapshot), &mut entry) };
    loop {
        match listed {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_NO_MORE_FILES.to_hresult() => break,
            Err(_) => return None,
        }
        // An entry too short to name its owner cannot be ruled out.
        if entry.dwSize < owner_end {
            return None;
        }
        // A second thread is never chosen between.
        if entry.th32OwnerProcessID == pid && found.replace(entry.th32ThreadID).is_some() {
            return None;
        }
        entry.dwSize = full;
        // SAFETY: as for the first entry.
        listed = unsafe { Thread32Next(borrowed(&snapshot), &mut entry) };
    }
    let thread_id = found?;
    // SAFETY: a successful call returns a new thread handle owned here.
    let thread = unsafe {
        adopt(
            OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                false,
                thread_id,
            )
            .ok()?,
        )
    };
    // SAFETY: `thread` is open with THREAD_QUERY_LIMITED_INFORMATION access.
    (unsafe { GetProcessIdOfThread(borrowed(&thread)) } == pid).then_some(thread)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_stream_job_resumes_only_the_creation_suspension() {
        assert_eq!(resumed(1), Resume::Once);
        // A failed call left the thread suspended: never run.
        assert_eq!(resumed(u32::MAX), Resume::NotResumed);
        // Already running, or held by a suspension this launch never made.
        for previous in [0, 2, 3, 127] {
            assert_eq!(resumed(previous), Resume::Unexpected, "{previous}");
        }
    }
}
