//! Disposable Windows CI fixture using the real installer handoff and receipt.
//! Never included in the shipped Desktop executable.
#[allow(dead_code)]
#[path = "../src/update_safety.rs"]
mod update_safety;
use std::{error::Error, fs, io::Write, path::Path, process::Stdio, time::Duration};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let version = option_env!("HACKERAI_UPGRADE_FIXTURE_VERSION").unwrap_or("0.0.0");
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 3 && args[1] == "detached-job" {
        let state = Path::new(&args[2]);
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(state.join("job-output.txt"))?;
        // Bounded even if the test driver fails before requesting cleanup.
        for sequence in 0..1800 {
            if state.join("stop-job").exists() {
                break;
            }
            writeln!(output, "{sequence}")?;
            output.flush()?;
            std::thread::sleep(Duration::from_millis(100));
        }
        return Ok(());
    }
    if args.len() == 1 {
        println!("{version}");
        return Ok(());
    }
    if args.len() != 5 {
        return Err("expected mode, loopback feed, public key file, state directory".into());
    }
    if !matches!(args[1].as_str(), "install" | "decline" | "reject") {
        return Err("expected install, decline or reject mode".into());
    }
    let state = Path::new(&args[4]);
    if let Some((_, outcome)) = update_safety::Receipt::take(state, version)? {
        let result = serde_json::json!({"version": version, "outcome": format!("{outcome:?}")});
        fs::write(state.join("result.json"), result.to_string())?;
        return Ok(());
    }
    let endpoint: url::Url = args[2].parse()?;
    if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1") {
        return Err("acceptance feed must be loopback HTTP".into());
    }
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = version.parse()?;
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "dangerousInsecureTransportProtocol": true, "endpoints": [endpoint],
            // Use the same default passive Windows install mode as Desktop.
            "pubkey": fs::read_to_string(&args[3])?.trim()
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)?;
    let update = app
        .updater_builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?
        .check()
        .await?
        .ok_or("expected newer version")?;
    let bytes = update.download(|_, _| {}, || {}).await?;
    #[cfg(windows)]
    if args[1] == "reject" {
        let mut extraction_rejected = false;
        let result = update_safety::install_after_approval(
            &update_safety::UpdateGate::default(),
            state,
            version,
            &update.version,
            true,
            || {
                let result = update.install(bytes);
                extraction_rejected =
                    matches!(&result, Err(tauri_plugin_updater::Error::Extract(_)));
                result.map_err(|e| e.to_string())
            },
        );
        if result.is_ok() || !extraction_rejected {
            return Err("expected signed package rejection at ZIP extraction".into());
        }
        assert!(state.join("pending-desktop-update.json").exists());
        fs::write(
            state.join("result.json"),
            serde_json::json!({"version": version, "outcome":"Rejected"}).to_string(),
        )?;
        return Ok(());
    }
    if args[1] == "install" {
        // Model a user tool outside the installation directory. Running a
        // second copy of the installed app would instead lock the exe being replaced.
        let worker = state.join("detached-job.exe");
        fs::copy(std::env::current_exe()?, &worker)?;
        let mut command = std::process::Command::new(worker);
        command
            .args(["detached-job", &args[4]])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Match Desktop's native command process creation flags.
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = command.spawn()?;
        fs::write(state.join("job-pid"), child.id().to_string())?;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let before = fs::read(state.join("job-output.txt")).unwrap_or_default();
            if !before.is_empty() {
                fs::write(state.join("job-before-update.txt"), before)?;
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err("detached job did not start".into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    update_safety::install_after_approval(
        &update_safety::UpdateGate::default(),
        state,
        version,
        &update.version,
        args[1] == "install",
        || update.install(bytes).map_err(|e| e.to_string()),
    )?;
    // A Windows install exits inside the SDK. Reaching here only on decline is
    // part of the acceptance contract; the relaunched N+1 writes result.json.
    if args[1] == "install" {
        return Err("Windows installer unexpectedly returned".into());
    }
    assert!(!state.join("pending-desktop-update.json").exists());
    fs::write(
        state.join("result.json"),
        serde_json::json!({"version": version, "outcome":"Declined"}).to_string(),
    )?;
    Ok(())
}
