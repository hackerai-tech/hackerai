//! Disposable Windows CI fixture using the real installer handoff and receipt.
//! Never included in the shipped Desktop executable.
#[allow(dead_code)]
#[path = "../src/update_safety.rs"]
mod update_safety;
use std::{error::Error, fs, path::Path, time::Duration};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let version = option_env!("HACKERAI_UPGRADE_FIXTURE_VERSION").unwrap_or("0.0.0");
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 1 {
        println!("{version}");
        return Ok(());
    }
    if args.len() != 5 {
        return Err("expected mode, loopback feed, public key file, state directory".into());
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
            "pubkey": fs::read_to_string(&args[3])?.trim(), "windows": {"installMode":"quiet"}
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
