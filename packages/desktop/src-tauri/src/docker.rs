use serde::{Deserialize, Serialize};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

/// Stores the running sandbox process
pub struct SandboxState {
    pub process: Mutex<Option<Child>>,
}

impl Default for SandboxState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DockerStatus {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SandboxStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub image: String,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SandboxConfig {
    pub token: String,
    pub name: String,
    pub image: Option<String>,
    pub dangerous: Option<bool>,
    pub persist: Option<bool>,
}

/// Checks if Docker is available on the system.
#[tauri::command]
pub async fn check_docker() -> Result<DockerStatus, String> {
    log::info!("Checking Docker availability");

    let output = Command::new("docker")
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    match output {
        Ok(result) if result.status.success() => {
            let version = String::from_utf8_lossy(&result.stdout)
                .trim()
                .to_string();
            log::info!("Docker available: {}", version);
            Ok(DockerStatus {
                available: true,
                version: Some(version),
                error: None,
            })
        }
        Ok(result) => {
            let error = String::from_utf8_lossy(&result.stderr).to_string();
            log::warn!("Docker check failed: {}", error);
            Ok(DockerStatus {
                available: false,
                version: None,
                error: Some(error),
            })
        }
        Err(e) => {
            let error = format!("Failed to run docker command: {}", e);
            log::warn!("{}", error);
            Ok(DockerStatus {
                available: false,
                version: None,
                error: Some(error),
            })
        }
    }
}

/// Checks if the sandbox image is available locally.
#[tauri::command]
pub async fn check_sandbox_image(image: Option<String>) -> Result<bool, String> {
    let image_name = image.unwrap_or_else(|| "hackerai/sandbox".to_string());
    log::info!("Checking for image: {}", image_name);

    let output = Command::new("docker")
        .args(["images", "-q", &image_name])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to check image: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let exists = !stdout.is_empty();

    log::info!("Image {} exists: {}", image_name, exists);
    Ok(exists)
}

/// Pulls the sandbox image.
#[tauri::command]
pub async fn pull_sandbox_image(image: Option<String>) -> Result<(), String> {
    let image_name = image.unwrap_or_else(|| "hackerai/sandbox".to_string());
    log::info!("Pulling image: {}", image_name);

    let output = Command::new("docker")
        .args(["pull", &image_name])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to pull image: {}", e))?;

    if output.status.success() {
        log::info!("Image pulled successfully: {}", image_name);
        Ok(())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).to_string();
        log::error!("Failed to pull image: {}", error);
        Err(format!("Pull failed: {}", error))
    }
}

/// Starts the local sandbox using the @hackerai/local CLI.
/// This spawns the CLI as a child process.
#[tauri::command]
pub async fn start_sandbox(
    config: SandboxConfig,
    state: State<'_, SandboxState>,
) -> Result<SandboxStatus, String> {
    log::info!("Starting sandbox with name: {}", config.name);

    // Check if already running
    {
        let process = state.process.lock().map_err(|e| e.to_string())?;
        if process.is_some() {
            return Err("Sandbox is already running".to_string());
        }
    }

    let image = config.image.unwrap_or_else(|| "hackerai/sandbox".to_string());
    let mut args = vec![
        "@hackerai/local".to_string(),
        "--token".to_string(),
        config.token.clone(),
        "--name".to_string(),
        config.name.clone(),
        "--image".to_string(),
        image.clone(),
    ];

    if config.dangerous.unwrap_or(false) {
        args.push("--dangerous".to_string());
    }

    if config.persist.unwrap_or(false) {
        args.push("--persist".to_string());
    }

    let child = Command::new("npx")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            log::error!("Failed to start sandbox: {}", e);
            format!("Failed to start sandbox: {}", e)
        })?;

    let pid = child.id();
    log::info!("Sandbox started with PID: {}", pid);

    // Store the process
    {
        let mut process = state.process.lock().map_err(|e| e.to_string())?;
        *process = Some(child);
    }

    Ok(SandboxStatus {
        running: true,
        pid: Some(pid),
        image,
        name: Some(config.name),
    })
}

/// Stops the running sandbox.
#[tauri::command]
pub async fn stop_sandbox(state: State<'_, SandboxState>) -> Result<(), String> {
    log::info!("Stopping sandbox");

    let mut process = state.process.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = process.take() {
        // Try graceful termination first
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            // Give it a moment to clean up
            std::thread::sleep(std::time::Duration::from_secs(2));
        }

        // Force kill if still running
        match child.try_wait() {
            Ok(Some(_)) => {
                log::info!("Sandbox stopped gracefully");
            }
            Ok(None) => {
                log::warn!("Sandbox didn't stop gracefully, killing");
                let _ = child.kill();
            }
            Err(e) => {
                log::error!("Error checking sandbox status: {}", e);
                let _ = child.kill();
            }
        }
    } else {
        log::debug!("No sandbox was running");
    }

    Ok(())
}

/// Gets the current sandbox status.
#[tauri::command]
pub async fn get_sandbox_status(state: State<'_, SandboxState>) -> Result<SandboxStatus, String> {
    let mut process = state.process.lock().map_err(|e| e.to_string())?;

    if let Some(ref mut child) = *process {
        match child.try_wait() {
            Ok(Some(status)) => {
                log::info!("Sandbox exited with status: {:?}", status);
                *process = None;
                Ok(SandboxStatus {
                    running: false,
                    pid: None,
                    image: "hackerai/sandbox".to_string(),
                    name: None,
                })
            }
            Ok(None) => Ok(SandboxStatus {
                running: true,
                pid: Some(child.id()),
                image: "hackerai/sandbox".to_string(),
                name: None,
            }),
            Err(e) => {
                log::error!("Error checking sandbox status: {}", e);
                *process = None;
                Err(format!("Status check failed: {}", e))
            }
        }
    } else {
        Ok(SandboxStatus {
            running: false,
            pid: None,
            image: "hackerai/sandbox".to_string(),
            name: None,
        })
    }
}
