use std::time::Duration;

/// Shell configuration for cross-platform command execution.
pub struct ShellConfig {
    pub shell: &'static str,
    pub flag: &'static str,
}

/// Get the shell and argument flag for the current platform.
/// Windows uses `cmd /C`, Unix uses `/bin/sh -c`.
pub fn get_shell_config() -> ShellConfig {
    if cfg!(target_os = "windows") {
        ShellConfig { shell: "cmd", flag: "/C" }
    } else {
        ShellConfig { shell: "/bin/sh", flag: "-c" }
    }
}

/// Build a `tokio::process::Command` from an exec request.
/// Centralizes shell selection, args, cwd, env, and stdio setup.
pub fn build_command(
    command: &str,
    cwd: Option<&str>,
    env: Option<&std::collections::HashMap<String, String>>,
) -> tokio::process::Command {
    let config = get_shell_config();
    let mut cmd = tokio::process::Command::new(config.shell);
    cmd.arg(config.flag).arg(command);

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
