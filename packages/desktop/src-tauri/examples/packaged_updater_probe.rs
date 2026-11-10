//! CI-only packaged updater probe. Never shipped as the Desktop executable.
//! Uses the pinned updater and Tauri's actual bundle marker, with an ephemeral
//! signing key and loopback feed. No account, relay or customer workspace access.
use std::{error::Error, time::Duration};
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
    if args.len() != 4 {
        return Err("expected feed URL, public key file and package suffix".into());
    }
    let endpoint: url::Url = args[1].parse()?;
    if endpoint.scheme() != "http" || endpoint.host_str() != Some("127.0.0.1") {
        return Err("acceptance feed must be loopback HTTP".into());
    }
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = version.parse()?;
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "dangerousInsecureTransportProtocol": true,
            "endpoints": [endpoint],
            "pubkey": std::fs::read_to_string(&args[2])?.trim(),
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)?;
    // Do not override target: the packaged binary must select its own type.
    let update = app
        .updater_builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?
        .check()
        .await?
        .ok_or("expected a newer version")?;
    if !update.download_url.path().ends_with(&args[3]) {
        return Err(format!("wrong package selected: {}", update.download_url.path()).into());
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    update.install(bytes)?;
    println!("installed {}", update.version);
    Ok(())
}
