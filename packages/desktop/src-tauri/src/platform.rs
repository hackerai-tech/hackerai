use std::time::Duration;

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
///   globally-installed CLIs like `codex`.
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
                if Path::new(&candidate).exists() {
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
            // like `"C:\temp\foo"` survive intact.
            use std::os::windows::process::CommandExt;
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
        if let Some(pid) = child.id() {
            // Send SIGTERM first for graceful shutdown
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            // Wait up to 2 seconds for the process to exit
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(_) => return,
                Err(_) => {
                    // Process didn't exit in time, escalate to SIGKILL
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
