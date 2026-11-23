//! Keeps this computer from idle-sleeping while Agent work runs on it.
//!
//! Activity is reported only by server-authorized Agent operations: every
//! redeemed operation marks activity, and a streamed command holds activity
//! until it ends. The lock is kept for `IDLE_GRACE` after the last activity so
//! the model's turn between two commands does not let the system sleep.
//!
//! Only idle system sleep is prevented. The display may still sleep, and a
//! closed lid or an explicit sleep request still sleeps. Every OS lock dies
//! with this process, so a crash cannot leave the computer awake. Failing to
//! acquire the lock is logged and retried with backoff; it never affects the
//! Agent operation that asked for it.

use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long the lock outlives the last Agent activity. Long enough to span a
/// model turn between commands, short enough to release soon after a run.
pub(crate) const IDLE_GRACE: Duration = Duration::from_secs(5 * 60);
const FIRST_RETRY: Duration = Duration::from_secs(5);
const MAX_RETRY: Duration = Duration::from_secs(5 * 60);
/// Bounds app exit's wait for the lock to be released.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(1);

/// The OS mechanism. Every call happens on the controller's own thread, which
/// Windows requires because its execution state belongs to the calling thread.
pub(crate) trait SleepLock {
    /// On failure, a closed failure class for logs, never OS output.
    fn acquire(&mut self) -> Result<(), &'static str>;
    fn release(&mut self);
}

/// Pure state machine: callers supply the time and the controller returns
/// when it next needs to be woken.
struct Controller<L> {
    lock: L,
    grace: Duration,
    active: usize,
    last_activity: Option<Instant>,
    held: bool,
    failures: u32,
    retry_at: Option<Instant>,
}

impl<L: SleepLock> Controller<L> {
    fn new(lock: L, grace: Duration) -> Self {
        Self {
            lock,
            grace,
            active: 0,
            last_activity: None,
            held: false,
            failures: 0,
            retry_at: None,
        }
    }

    fn begin(&mut self, now: Instant) -> Option<Instant> {
        self.active += 1;
        self.touch(now)
    }

    fn end(&mut self, now: Instant) -> Option<Instant> {
        self.active = self.active.saturating_sub(1);
        self.touch(now)
    }

    fn touch(&mut self, now: Instant) -> Option<Instant> {
        self.last_activity = Some(now);
        self.reconcile(now)
    }

    fn idle_deadline(&self) -> Option<Instant> {
        if self.active > 0 {
            return None;
        }
        self.last_activity.map(|last| last + self.grace)
    }

    fn wanted(&self, now: Instant) -> bool {
        self.active > 0 || self.idle_deadline().is_some_and(|deadline| now < deadline)
    }

    /// Acquire or release as activity requires; returns the next wake time.
    fn reconcile(&mut self, now: Instant) -> Option<Instant> {
        if !self.wanted(now) {
            if self.held {
                self.lock.release();
                self.held = false;
                log::info!("Desktop keep-awake released after Agent activity ended");
            }
            self.failures = 0;
            self.retry_at = None;
            return None;
        }
        if !self.held && self.retry_at.is_none_or(|retry| now >= retry) {
            match self.lock.acquire() {
                Ok(()) => {
                    self.held = true;
                    self.failures = 0;
                    self.retry_at = None;
                    log::info!("Desktop keep-awake acquired for Agent activity");
                }
                Err(class) => {
                    self.failures += 1;
                    let delay = retry_delay(self.failures);
                    self.retry_at = Some(now + delay);
                    log::warn!(
                        "Desktop keep-awake unavailable ({class}); attempt {}, retrying in {}s",
                        self.failures,
                        delay.as_secs()
                    );
                }
            }
        }
        let retry = self.retry_at.filter(|_| !self.held);
        match (self.idle_deadline(), retry) {
            (Some(idle), Some(retry)) => Some(idle.min(retry)),
            (idle, retry) => idle.or(retry),
        }
    }

    fn shutdown(&mut self) {
        if self.held {
            self.lock.release();
            self.held = false;
            log::info!("Desktop keep-awake released at exit");
        }
        self.active = 0;
        self.last_activity = None;
        self.retry_at = None;
    }
}

fn retry_delay(failures: u32) -> Duration {
    FIRST_RETRY
        .saturating_mul(1 << failures.saturating_sub(1).min(16))
        .min(MAX_RETRY)
}

enum Message {
    Begin,
    End,
    Touch,
    Shutdown(mpsc::Sender<()>),
}

fn drive<L: SleepLock>(mut controller: Controller<L>, messages: mpsc::Receiver<Message>) {
    let mut wake: Option<Instant> = None;
    loop {
        let message = match wake {
            Some(at) => match messages.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(message) => Some(message),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match messages.recv() {
                Ok(message) => Some(message),
                Err(_) => break,
            },
        };
        let now = Instant::now();
        wake = match message {
            Some(Message::Begin) => controller.begin(now),
            Some(Message::End) => controller.end(now),
            Some(Message::Touch) => controller.touch(now),
            Some(Message::Shutdown(done)) => {
                controller.shutdown();
                let _ = done.send(());
                return;
            }
            None => controller.reconcile(now),
        };
    }
    controller.shutdown();
}

/// App-managed handle. Sends never block an Agent operation.
pub(crate) struct KeepAwake {
    messages: mpsc::Sender<Message>,
}

/// Agent activity in progress; ending it starts the idle grace.
pub(crate) struct Activity<'a>(&'a KeepAwake);

impl Drop for Activity<'_> {
    fn drop(&mut self) {
        let _ = self.0.messages.send(Message::End);
    }
}

impl KeepAwake {
    pub(crate) fn start() -> Self {
        Self::start_with(platform::lock, IDLE_GRACE)
    }

    /// The lock is created on the controller thread, which owns it for life.
    fn start_with<L, F>(make_lock: F, grace: Duration) -> Self
    where
        L: SleepLock,
        F: FnOnce() -> L + Send + 'static,
    {
        let (messages, received) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || drive(Controller::new(make_lock(), grace), received));
        if spawned.is_err() {
            // The receiver is gone, so every later send is a silent no-op.
            log::warn!("Desktop keep-awake unavailable (thread_spawn_failed)");
        }
        Self { messages }
    }

    pub(crate) fn activity(&self) -> Activity<'_> {
        let _ = self.messages.send(Message::Begin);
        Activity(self)
    }

    pub(crate) fn touch(&self) {
        let _ = self.messages.send(Message::Touch);
    }

    /// Release now and stop the controller. The OS releases the lock with the
    /// process anyway; this keeps a normal exit prompt and logged.
    pub(crate) fn shutdown(&self) {
        let (done, finished) = mpsc::channel();
        if self.messages.send(Message::Shutdown(done)).is_ok() {
            let _ = finished.recv_timeout(SHUTDOWN_WAIT);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    //! An IOKit assertion owned by this process; powerd drops it if the
    //! process dies. `pmset -g assertions` lists it under this app.
    use std::ffi::{c_char, c_void, CStr};

    type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;
    const LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            value: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    struct CfString(CFStringRef);

    impl CfString {
        fn new(value: &CStr) -> Option<Self> {
            // SAFETY: a NUL-terminated UTF-8 string and the default allocator.
            let string =
                unsafe { CFStringCreateWithCString(std::ptr::null(), value.as_ptr(), UTF8) };
            (!string.is_null()).then_some(Self(string))
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            // SAFETY: created above and released exactly once.
            unsafe { CFRelease(self.0) }
        }
    }

    pub(super) struct AssertionLock(Option<u32>);

    pub(super) fn lock() -> AssertionLock {
        AssertionLock(None)
    }

    impl super::SleepLock for AssertionLock {
        fn acquire(&mut self) -> Result<(), &'static str> {
            let (Some(kind), Some(name)) = (
                CfString::new(c"PreventUserIdleSystemSleep"),
                CfString::new(c"HackerAI Agent is running commands on this computer"),
            ) else {
                return Err("assertion_name_unavailable");
            };
            let mut id = 0;
            // SAFETY: valid CFStrings and an out pointer to a live u32.
            let status = unsafe { IOPMAssertionCreateWithName(kind.0, LEVEL_ON, name.0, &mut id) };
            if status != 0 {
                return Err("assertion_rejected");
            }
            self.0 = Some(id);
            Ok(())
        }

        fn release(&mut self) {
            if let Some(id) = self.0.take() {
                // SAFETY: an assertion this lock created and has not released.
                if unsafe { IOPMAssertionRelease(id) } != 0 {
                    log::warn!("Desktop keep-awake release was not confirmed");
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    //! The controller thread's execution state; Windows clears it when the
    //! thread or process ends. `powercfg /requests` lists it under SYSTEM.
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    pub(super) struct ExecutionStateLock;

    pub(super) fn lock() -> ExecutionStateLock {
        ExecutionStateLock
    }

    impl super::SleepLock for ExecutionStateLock {
        fn acquire(&mut self) -> Result<(), &'static str> {
            // SAFETY: plain flags; affects only the calling thread.
            if unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } == 0 {
                return Err("execution_state_rejected");
            }
            Ok(())
        }

        fn release(&mut self) {
            // SAFETY: as above; clears this thread's requirement.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    //! A logind sleep inhibitor held by `systemd-inhibit`. Its child exits
    //! when this app's PID exits, which ends the inhibitor even after a crash.
    //! logind ignores inhibitors for lid switches by default.
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;

    /// An inhibitor that cannot reach logind exits almost immediately.
    const STARTUP_CHECK: Duration = Duration::from_millis(250);

    pub(super) struct InhibitorLock(Option<Child>);

    pub(super) fn lock() -> InhibitorLock {
        InhibitorLock(None)
    }

    impl super::SleepLock for InhibitorLock {
        fn acquire(&mut self) -> Result<(), &'static str> {
            let mut child = Command::new("systemd-inhibit")
                .args([
                    "--what=sleep",
                    "--mode=block",
                    "--who=HackerAI",
                    "--why=HackerAI Agent is running commands on this computer",
                    "tail",
                    &format!("--pid={}", std::process::id()),
                    "-f",
                    "/dev/null",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                // Its own group, so release stops the inhibitor and `tail`.
                .process_group(0)
                .spawn()
                .map_err(|_| "inhibitor_spawn_failed")?;
            std::thread::sleep(STARTUP_CHECK);
            if !matches!(child.try_wait(), Ok(None)) {
                let _ = child.wait();
                return Err("inhibitor_exited");
            }
            self.0 = Some(child);
            Ok(())
        }

        fn release(&mut self) {
            if let Some(mut child) = self.0.take() {
                if let Ok(group) = libc::pid_t::try_from(child.id()) {
                    // SAFETY: the group this lock created; its leader is
                    // unreaped, so the group ID cannot have been reused.
                    unsafe { libc::killpg(group, libc::SIGTERM) };
                }
                let _ = child.wait();
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    pub(super) struct Unsupported;

    pub(super) fn lock() -> Unsupported {
        Unsupported
    }

    impl super::SleepLock for Unsupported {
        fn acquire(&mut self) -> Result<(), &'static str> {
            Err("unsupported_platform")
        }

        fn release(&mut self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<FakeState>>);

    #[derive(Default)]
    struct FakeState {
        held: bool,
        acquires: usize,
        releases: usize,
        failures_left: usize,
    }

    impl Fake {
        fn failing(times: usize) -> Self {
            let fake = Self::default();
            fake.0.lock().unwrap().failures_left = times;
            fake
        }

        fn held(&self) -> bool {
            self.0.lock().unwrap().held
        }

        fn counts(&self) -> (usize, usize) {
            let state = self.0.lock().unwrap();
            (state.acquires, state.releases)
        }
    }

    impl SleepLock for Fake {
        fn acquire(&mut self) -> Result<(), &'static str> {
            let mut state = self.0.lock().unwrap();
            assert!(!state.held, "acquired twice");
            state.acquires += 1;
            if state.failures_left > 0 {
                state.failures_left -= 1;
                return Err("fake_failure");
            }
            state.held = true;
            Ok(())
        }

        fn release(&mut self) {
            let mut state = self.0.lock().unwrap();
            assert!(state.held, "released without holding");
            state.held = false;
            state.releases += 1;
        }
    }

    const GRACE: Duration = Duration::from_secs(60);

    fn at(start: Instant, seconds: u64) -> Instant {
        start + Duration::from_secs(seconds)
    }

    #[test]
    fn holds_while_active_and_releases_only_after_the_idle_grace() {
        let fake = Fake::default();
        let mut controller = Controller::new(fake.clone(), GRACE);
        let start = Instant::now();

        assert_eq!(controller.begin(start), None, "no deadline while running");
        assert!(fake.held());
        // A command running far longer than the grace keeps the lock.
        assert_eq!(controller.reconcile(at(start, 3600)), None);
        assert!(fake.held());

        let ended = at(start, 3600);
        assert_eq!(controller.end(ended), Some(ended + GRACE));
        assert!(controller.reconcile(at(start, 3659)).is_some());
        assert!(fake.held(), "released before the grace elapsed");
        assert_eq!(controller.reconcile(at(start, 3660)), None);
        assert!(!fake.held());
        assert_eq!(fake.counts(), (1, 1));
    }

    #[test]
    fn activity_during_the_grace_extends_it_without_reacquiring() {
        let fake = Fake::default();
        let mut controller = Controller::new(fake.clone(), GRACE);
        let start = Instant::now();

        controller.touch(start);
        controller.reconcile(at(start, 50));
        assert_eq!(controller.touch(at(start, 50)), Some(at(start, 110)));
        controller.begin(at(start, 100));
        controller.end(at(start, 105));
        controller.reconcile(at(start, 164));
        assert!(fake.held());
        controller.reconcile(at(start, 165));
        assert!(!fake.held());
        assert_eq!(fake.counts(), (1, 1));
    }

    #[test]
    fn one_ending_command_keeps_the_lock_for_another_still_running() {
        let fake = Fake::default();
        let mut controller = Controller::new(fake.clone(), GRACE);
        let start = Instant::now();

        controller.begin(start);
        controller.begin(start);
        controller.end(at(start, 1));
        assert_eq!(controller.reconcile(at(start, 600)), None);
        assert!(fake.held());
        controller.end(at(start, 600));
        controller.reconcile(at(start, 660));
        assert!(!fake.held());
    }

    #[test]
    fn acquisition_failure_is_retried_with_backoff_and_never_released() {
        let fake = Fake::failing(2);
        let mut controller = Controller::new(fake.clone(), Duration::from_secs(3600));
        let start = Instant::now();

        assert_eq!(controller.begin(start), Some(at(start, 5)));
        // More activity before the retry time does not hammer the OS.
        controller.touch(at(start, 1));
        assert_eq!(fake.counts(), (1, 0));
        assert_eq!(controller.reconcile(at(start, 5)), Some(at(start, 15)));
        assert_eq!(controller.reconcile(at(start, 15)), None);
        assert!(fake.held());
        assert_eq!(fake.counts(), (3, 0));
    }

    #[test]
    fn failure_backoff_is_dropped_once_activity_ends() {
        let fake = Fake::failing(1);
        let mut controller = Controller::new(fake.clone(), GRACE);
        let start = Instant::now();

        controller.touch(start);
        assert_eq!(controller.reconcile(at(start, 60)), None);
        // A later run tries immediately instead of waiting out old backoff.
        controller.touch(at(start, 61));
        assert!(fake.held());
    }

    #[test]
    fn retry_delay_doubles_up_to_the_cap() {
        assert_eq!(retry_delay(1), Duration::from_secs(5));
        assert_eq!(retry_delay(2), Duration::from_secs(10));
        assert_eq!(retry_delay(7), Duration::from_secs(300));
        assert_eq!(retry_delay(u32::MAX), MAX_RETRY);
    }

    #[test]
    fn shutdown_releases_even_while_a_command_runs() {
        let fake = Fake::default();
        let mut controller = Controller::new(fake.clone(), GRACE);
        controller.begin(Instant::now());
        controller.shutdown();
        assert!(!fake.held());
        assert_eq!(fake.counts(), (1, 1));
    }

    fn wait_until(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "condition not reached");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn driver_releases_after_the_grace_and_on_shutdown() {
        let fake = Fake::default();
        let lock = fake.clone();
        let keep_awake = KeepAwake::start_with(move || lock, Duration::from_millis(50));

        drop(keep_awake.activity());
        wait_until(|| fake.counts() == (1, 1));

        let running = keep_awake.activity();
        wait_until(|| fake.held());
        keep_awake.shutdown();
        assert!(!fake.held(), "shutdown returned before releasing");
        drop(running);
        assert_eq!(fake.counts(), (2, 2));
    }
}
