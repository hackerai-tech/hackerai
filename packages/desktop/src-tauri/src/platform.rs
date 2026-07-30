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
                ("cmd".to_string(), "/C", true)
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
///   3. `where git` → `<gitDir>/../../bin/bash.exe`
#[cfg(windows)]
fn find_git_bash() -> Option<String> {
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

    if let Ok(out) = StdCommand::new("where").arg("git").output() {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                let line = line.trim();
                if line.to_lowercase().ends_with("git.exe") {
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
/// On Windows: calls kill() directly (which is always immediate).
/// Always reaps the process with wait() afterward.
pub async fn graceful_kill(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        use std::time::Duration;
        if let Some(pid) = child.id() {
            // Send SIGTERM first for graceful shutdown
            terminate_process_group(pid, libc::SIGTERM);
            // Wait up to 2 seconds for the process to exit
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(_) => return,
                Err(_) => {
                    // Process didn't exit in time, escalate to SIGKILL
                    terminate_process_group(pid, libc::SIGKILL);
                    let _ = child.kill().await;
                }
            }
        } else {
            // No PID available (already exited), just try kill
            let _ = child.kill().await;
        }
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill().await;
    }

    // Reap the process to avoid zombies
    let _ = child.wait().await;
}

#[cfg(unix)]
fn terminate_process_group(pid: u32, signal: libc::c_int) {
    let pid = pid as libc::pid_t;
    unsafe {
        // build_command places each command in a fresh session, making the
        // child pid also the process-group id. Kill the group so pipelines and
        // shell grandchildren stop together.
        if libc::kill(-pid, signal) == -1 {
            let _ = libc::kill(pid, signal);
        }
    }
}

/// Cancel a streaming command and report success only after the OS confirms
/// that the process tree is no longer running.
pub async fn cancel_process_tree(pid: u32) -> bool {
    #[cfg(unix)]
    {
        terminate_process_group(pid, libc::SIGTERM);
        for _ in 0..10 {
            if !process_group_is_running(pid) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        terminate_process_group(pid, libc::SIGKILL);
        for _ in 0..20 {
            if !process_group_is_running(pid) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        return !process_group_is_running(pid);
    }

    #[cfg(windows)]
    {
        return tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await
            .map(|output| output.status.success())
            .unwrap_or(false);
    }

    #[cfg(not(any(unix, windows)))]
    {
        false
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
