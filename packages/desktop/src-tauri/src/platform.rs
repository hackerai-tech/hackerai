/// Stops console children (bash, cmd, taskkill) from opening a visible window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Check if a path is executable (Unix: has execute permission).
#[cfg(not(windows))]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Shell configuration for cross-platform command execution.
pub struct ShellConfig {
    pub shell: String,
    pub flag: &'static str,
    /// True when `shell` is `cmd.exe` and requires the verbatim-arg workaround
    /// for its non-MSVCRT quoting rules. Only consulted on Windows.
    #[allow(dead_code)]
    pub is_cmd: bool,
}

/// Get the shell for the current platform.
///
/// - **Windows:** prefer `bash.exe` from Git for Windows (POSIX semantics, no
///   cmd.exe quoting quirks). Override with `HACKERAI_BASH_PATH`. Falls back
///   to `cmd /C` when git-bash is not installed.
/// - **Unix:** the user's `$SHELL` as a login shell so PATH from
///   `.zshrc` / `.bashrc` / `.profile` is sourced — needed to find
///   globally-installed CLIs (e.g. those in `~/.local/bin` or
///   `nvm`/`pyenv`-managed bin dirs).
pub fn get_shell_config() -> ShellConfig {
    #[cfg(windows)]
    {
        static WIN_SHELL: std::sync::OnceLock<(String, &'static str, bool)> =
            std::sync::OnceLock::new();
        let (shell, flag, is_cmd) = WIN_SHELL.get_or_init(|| {
            if let Some(bash) = find_git_bash() {
                (bash, "-c", false)
            } else {
                (windows_system_executable("cmd.exe"), "/C", true)
            }
        });
        return ShellConfig {
            shell: shell.clone(),
            flag,
            is_cmd: *is_cmd,
        };
    }
    #[cfg(not(windows))]
    {
        static USER_SHELL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let shell = USER_SHELL.get_or_init(|| {
            use std::path::Path;
            let candidates = [
                std::env::var("SHELL").ok(),
                Some("/bin/sh".to_string()),
                Some("/bin/bash".to_string()),
                Some("/usr/bin/sh".to_string()),
                Some("/usr/bin/bash".to_string()),
            ];
            for candidate in candidates.into_iter().flatten() {
                let p = Path::new(&candidate);
                if p.is_file() && is_executable(p) {
                    return candidate;
                }
            }
            // Last resort — hope the OS can resolve "sh" via PATH
            "sh".to_string()
        });
        ShellConfig {
            shell: shell.clone(),
            flag: "-lc",
            is_cmd: false,
        }
    }
}

/// Locate `bash.exe` from Git for Windows. Tries:
///   1. `HACKERAI_BASH_PATH` env override
///   2. Common install locations
///   3. System `where.exe` searches PATH → `<gitDir>/../../bin/bash.exe`
#[cfg(windows)]
fn windows_system_executable(name: &str) -> String {
    use std::path::PathBuf;

    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("System32")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;

    if let Ok(p) = std::env::var("HACKERAI_BASH_PATH") {
        if PathBuf::from(&p).exists() {
            return Some(p);
        }
    }

    let candidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    for c in &candidates {
        if PathBuf::from(c).exists() {
            return Some((*c).to_string());
        }
    }

    if let Ok(out) = StdCommand::new(windows_system_executable("where.exe"))
        .arg("$PATH:git.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if PathBuf::from(line).is_absolute() && line.to_lowercase().ends_with("git.exe") {
                    // <gitDir>/cmd/git.exe → <gitDir>/bin/bash.exe
                    let p = PathBuf::from(line);
                    if let Some(git_dir) = p.parent().and_then(|d| d.parent()) {
                        let bash = git_dir.join("bin").join("bash.exe");
                        if bash.exists() {
                            return bash.to_str().map(|s| s.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Build a `tokio::process::Command` from an exec request.
/// Centralizes shell selection, args, cwd, env, and stdio setup.
pub fn build_command(
    command: &str,
    cwd: Option<&str>,
    env: Option<&std::collections::HashMap<String, String>>,
) -> tokio::process::Command {
    let config = get_shell_config();
    let mut cmd = tokio::process::Command::new(&config.shell);

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
        if config.is_cmd {
            // cmd.exe does not understand MSVCRT-style `\"` escaping that
            // Rust's std `Command::arg` applies on Windows. Use `raw_arg`
            // to pass the command line through verbatim, wrapped in the
            // outer quotes that `cmd /C` expects, so embedded quoted paths
            // like `"C:\temp\foo"` survive intact. tokio's Command exposes
            // raw_arg natively on Windows, no CommandExt import needed.
            cmd.arg(config.flag);
            cmd.raw_arg(format!("\"{}\"", command));
        } else {
            // git-bash and other POSIX shells handle their own quoting fine.
            cmd.arg(config.flag).arg(command);
        }
    }
    #[cfg(not(windows))]
    {
        cmd.arg(config.flag).arg(command);
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    if let Some(libraries) = crate::child_environment::appimage_library_path_override() {
        match libraries {
            Some(value) => {
                cmd.env("LD_LIBRARY_PATH", value);
            }
            None => {
                cmd.env_remove("LD_LIBRARY_PATH");
            }
        }
    }

    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    cmd
}

/// Gracefully kill a child process.
///
/// On Unix: sends SIGTERM, waits up to 2 seconds, then sends SIGKILL.
/// On Windows: stops the process tree before killing/reaping the shell.
/// Reaps the process with a bounded wait() afterward. True only when the tree,
/// as `cancel_process_tree` defines it, was confirmed stopped and the shell
/// reaped; anything else is unknown.
pub async fn graceful_kill(child: &mut tokio::process::Child) -> bool {
    use std::time::Duration;
    #[cfg(unix)]
    let stopped = {
        if let Some(pid) = child.id() {
            // Send SIGTERM first for graceful shutdown
            terminate_process_group(pid, libc::SIGTERM);
            // Wait up to 2 seconds for the process to exit
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    // Process didn't exit in time, escalate to SIGKILL
                    terminate_process_group(pid, libc::SIGKILL);
                    let _ = child.kill().await;
                }
            }
            // A reaped shell does not prove its descendants stopped. Verify
            // the group and escalate survivors before releasing update admission.
            cancel_process_tree(pid).await
        } else {
            // Already reaped by this owner: no live PID remains to signal.
            true
        }
    };

    #[cfg(not(unix))]
    let stopped = {
        // Killing only bash/cmd can leave its native descendants writing
        // files after the caller releases update admission.
        let stopped = match child.id() {
            Some(pid) => cancel_process_tree(pid).await,
            None => true,
        };
        let _ = child.kill().await;
        stopped
    };

    // Reap the process to avoid zombies, without waiting forever on a shell
    // that cannot be stopped.
    let reaped = matches!(
        tokio::time::timeout(Duration::from_secs(5), child.wait()).await,
        Ok(Ok(_))
    );
    stopped && reaped
}

#[cfg(unix)]
fn terminate_process_group(pid: u32, signal: libc::c_int) {
    let pid = pid as libc::pid_t;
    // build_command places each command in a fresh session (spawn fails if
    // setsid fails), making the child pid also the process-group id. Kill the
    // group so pipelines and shell grandchildren stop together. A missing group
    // means the tree is gone; never fall back to the positive PID, which may
    // since name an unrelated process.
    unsafe {
        let _ = libc::kill(-pid, signal);
    }
}

/// Cancel a streaming command and report success only after the OS confirms
/// that its tree is no longer running: on Unix, the command's process group;
/// on Windows, `taskkill /T` from the shell. On Unix, descendants that left the
/// group (`setsid`, `setpgid`, daemonizing) are neither signaled nor counted.
/// An unknown outcome fences updates even when a caller returns or aborts its
/// output readers. Other work remains available for the rest of the session.
pub async fn cancel_process_tree(pid: u32) -> bool {
    cancel_process_tree_observed(pid).await.is_ok()
}

/// How Windows `taskkill` failed to confirm a tree stopped: a closed class of
/// its result, never its output, text, PID or OS error.
// Only the Windows path and tests construct a failure.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskkillFailure {
    /// It exited unsuccessfully, with its nonzero code when the OS reported one.
    NonzeroExit(Option<std::num::NonZeroI32>),
    /// It could not be spawned or its completion could not be collected.
    OutputError,
}

/// `cancel_process_tree`, which delegates here: Ok only when confirmed stopped.
/// An unconfirmed outcome carries the closed failure only from the Windows
/// taskkill path; every other path reports None.
pub(crate) async fn cancel_process_tree_observed(pid: u32) -> Result<(), Option<TaskkillFailure>> {
    #[cfg(unix)]
    let stopped = {
        terminate_process_group(pid, libc::SIGTERM);
        for _ in 0..10 {
            if !process_group_is_running(pid) {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        terminate_process_group(pid, libc::SIGKILL);
        for _ in 0..20 {
            if !process_group_is_running(pid) {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        if process_group_is_running(pid) {
            Err(None)
        } else {
            Ok(())
        }
    };

    #[cfg(windows)]
    let stopped = taskkill_outcome(
        tokio::process::Command::new(windows_system_executable("taskkill.exe"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            // Only the status: captured output is never read.
            .map(|output| output.status),
    )
    .map_err(Some);

    #[cfg(not(any(unix, windows)))]
    let stopped = Err(None);

    if stopped.is_err() {
        crate::update_safety::UPDATE_GATE.block_for_unconfirmed_command();
    }
    stopped
}

/// Confirmed only by a successful exit, as before; otherwise which of the two
/// existing failures occurred.
#[cfg(any(windows, test))]
fn taskkill_outcome(
    result: std::io::Result<std::process::ExitStatus>,
) -> Result<(), TaskkillFailure> {
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(TaskkillFailure::NonzeroExit(
            status.code().and_then(std::num::NonZeroI32::new),
        )),
        Err(_) => Err(TaskkillFailure::OutputError),
    }
}

#[cfg(unix)]
fn process_group_is_running(pid: u32) -> bool {
    let pid = pid as libc::pid_t;
    let result = unsafe { libc::kill(-pid, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroI32;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    use std::process::ExitStatus;

    #[test]
    fn taskkill_outcome_keeps_its_confirmation_and_separates_exit_from_output_error() {
        #[cfg(unix)]
        let exited = |code: u8| ExitStatus::from_raw(i32::from(code) << 8);
        #[cfg(windows)]
        let exited = |code: u8| ExitStatus::from_raw(u32::from(code));
        let mut cases = vec![
            // Only a successful exit confirms the tree stopped.
            (Ok(exited(0)), Ok(())),
            (
                Ok(exited(1)),
                Err(TaskkillFailure::NonzeroExit(NonZeroI32::new(1))),
            ),
            (
                Ok(exited(128)),
                Err(TaskkillFailure::NonzeroExit(NonZeroI32::new(128))),
            ),
            (
                Err(std::io::Error::other("spawn failed")),
                Err(TaskkillFailure::OutputError),
            ),
        ];
        // An unsuccessful status without a code stays a nonzero exit.
        #[cfg(unix)]
        cases.push((
            Ok(ExitStatus::from_raw(libc::SIGKILL)),
            Err(TaskkillFailure::NonzeroExit(None)),
        ));
        // Windows codes keep their signed 32-bit value.
        #[cfg(windows)]
        cases.push((
            Ok(ExitStatus::from_raw(0xC000_013A)),
            Err(TaskkillFailure::NonzeroExit(NonZeroI32::new(
                -1_073_741_510,
            ))),
        ));
        for (result, expected) in cases {
            let label = format!("{result:?}");
            assert_eq!(taskkill_outcome(result), expected, "{label}");
        }
    }
}
