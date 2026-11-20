use super::{check_update, UpdateFlow, UpdatePrompts, UpdateStop};
use crate::update_safety::{Operation, Receipt, RestartResult, UpdateGate};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::{Error, UpdaterExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const SHORT_TIMEOUT: Duration = Duration::from_millis(500);
const GUARD_TIMEOUT: Duration = Duration::from_secs(5);
// Synthetic signed bytes for download-only tests; the signing key was discarded.
const PAYLOAD: &[u8] = b"HackerAI updater network test payload\n";
const PUBLIC_KEY: &str = include_str!("../tests/fixtures/updater.pub");
const SIGNATURE: &str = include_str!("../tests/fixtures/updater.sig");

enum Response {
    StallHeaders,
    StallBody,
    NoUpdate,
    Unavailable,
    /// A manifest offering `version` from `/download/<package>`. Every package
    /// serves the one signed fixture, so the request path identifies it.
    Release(&'static str, &'static str),
    Payload,
    TamperedPayload,
}

/// Requests and prompts in the order they happened.
type Log = Arc<Mutex<Vec<String>>>;

struct Server {
    endpoint: url::Url,
    log: Log,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start(responses: Vec<Response>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint: url::Url = format!("http://{}/update", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let base = endpoint.clone();
        let log = Log::default();
        let requests = log.clone();
        let task = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if stream.read(&mut byte).await.unwrap() == 0 {
                        return;
                    }
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let path = request.split(' ').nth(1).unwrap_or_default().to_string();
                let revalidates = request.contains("\r\ncache-control: no-cache\r\n");
                requests
                    .lock()
                    .unwrap()
                    .push(match (path.as_str(), revalidates) {
                        ("/update", true) => "check".into(),
                        ("/update", false) => "check without revalidation".into(),
                        (path, false) => format!("download {path}"),
                        (path, true) => format!("download {path} with manifest cache header"),
                    });
                let body = match response {
                    Response::StallHeaders | Response::StallBody => {
                        if matches!(response, Response::StallBody) {
                            stream
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10000\r\n\r\nx")
                                .await
                                .unwrap();
                        }
                        // The next response is available only after the timed-out client closes.
                        let mut discarded = Vec::new();
                        let _ = stream.read_to_end(&mut discarded).await;
                        continue;
                    }
                    Response::NoUpdate | Response::Unavailable => {
                        let status = if matches!(response, Response::NoUpdate) {
                            "204 No Content"
                        } else {
                            "503 Service Unavailable"
                        };
                        stream
                            .write_all(
                                format!(
                                    "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                )
                                .as_bytes(),
                            )
                            .await
                            .unwrap();
                        continue;
                    }
                    Response::Release(version, package) => serde_json::json!({
                        "version": version,
                        "url": base.join(&format!("/download/{package}")).unwrap(),
                        "signature": SIGNATURE.trim(),
                    })
                    .to_string()
                    .into_bytes(),
                    Response::Payload => PAYLOAD.to_vec(),
                    Response::TamperedPayload => b"tampered update".to_vec(),
                };
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(headers.as_bytes()).await.unwrap();
                stream.write_all(&body).await.unwrap();
            }
        });
        Self {
            endpoint,
            log,
            task,
        }
    }
}

fn app(server: &Server) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "dangerousInsecureTransportProtocol": true,
            "endpoints": [server.endpoint],
            "pubkey": PUBLIC_KEY.trim(),
        }),
    );
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}

fn assert_timeout(error: Error) {
    assert!(
        matches!(error, Error::Reqwest(ref cause) if cause.is_timeout()),
        "{error:?}"
    );
}

#[tokio::test]
async fn stalled_update_checks_time_out_and_allow_a_later_check() {
    for stall in [Response::StallHeaders, Response::StallBody] {
        let server = Server::start(vec![stall, Response::NoUpdate]).await;
        let app = app(&server);
        let result = tokio::time::timeout(
            GUARD_TIMEOUT,
            check_update(
                app.updater_builder().no_proxy(),
                SHORT_TIMEOUT,
                GUARD_TIMEOUT,
            ),
        )
        .await
        .expect("check must finish before the test guard");
        assert_timeout(result.err().expect("stalled check must fail"));
        let retry = tokio::time::timeout(
            GUARD_TIMEOUT,
            check_update(
                app.updater_builder().no_proxy(),
                SHORT_TIMEOUT,
                GUARD_TIMEOUT,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(retry.is_none());
    }
}

#[tokio::test]
async fn stalled_downloads_use_their_own_deadline_and_can_retry() {
    for stall in [Response::StallHeaders, Response::StallBody] {
        let server = Server::start(vec![
            Response::Release("99.0.0", "99.0.0"),
            stall,
            Response::Payload,
        ])
        .await;
        let app = app(&server);
        let update = check_update(
            app.updater_builder().no_proxy(),
            GUARD_TIMEOUT,
            SHORT_TIMEOUT,
        )
        .await
        .unwrap()
        .unwrap();
        let mut finished = false;
        let result = tokio::time::timeout(
            GUARD_TIMEOUT,
            update.download(|_, _| {}, || finished = true),
        )
        .await
        .expect("download must use its own deadline");
        assert_timeout(result.unwrap_err());
        assert!(
            !finished,
            "partial downloads must not reach installation readiness"
        );
        let bytes = tokio::time::timeout(GUARD_TIMEOUT, update.download(|_, _| {}, || {}))
            .await
            .unwrap()
            .expect("retry must download and verify the signed payload");
        assert_eq!(bytes, PAYLOAD);
    }
}

#[tokio::test]
async fn download_deadline_preserves_signature_verification() {
    let server = Server::start(vec![
        Response::Release("99.0.0", "99.0.0"),
        Response::TamperedPayload,
    ])
    .await;
    let app = app(&server);
    let update = check_update(
        app.updater_builder().no_proxy(),
        GUARD_TIMEOUT,
        SHORT_TIMEOUT,
    )
    .await
    .unwrap()
    .unwrap();
    let error = update.download(|_, _| {}, || {}).await.unwrap_err();
    assert!(matches!(error, Error::Minisign(_)), "{error:?}");
}

/// Accepts every prompt. The first retry prompt ends the held active work,
/// as if the user finished it before choosing Install now again.
struct Prompts<'g> {
    log: Log,
    busy: Option<Operation<'g>>,
    retries: Vec<String>,
}

impl UpdatePrompts for Prompts<'_> {
    fn offer(&mut self, version: &str) -> bool {
        self.log.lock().unwrap().push(format!("offer {version}"));
        true
    }
    fn approve(&mut self, version: &str) -> bool {
        self.log.lock().unwrap().push(format!("approve {version}"));
        true
    }
    fn retry(&mut self, message: &str) -> bool {
        self.log.lock().unwrap().push("retry".into());
        self.retries.push(message.into());
        self.busy = None;
        true
    }
    fn stop(&mut self, outcome: UpdateStop) {
        let label = match outcome {
            UpdateStop::CheckFailed(_) => "check failed",
            UpdateStop::NoLongerOffered => "no longer offered",
            UpdateStop::DownloadFailed => "download failed",
            UpdateStop::NotPrepared => "not prepared",
            UpdateStop::InstallFailed(_) => "install failed",
        };
        self.log.lock().unwrap().push(format!("stop: {label}"));
    }
}

/// Runs the native update sequence against the loopback feed: an initial
/// check, then the flow with scripted prompts. Installation records the
/// release and bytes handed to the installer and the receipt it saved.
async fn run_flow(
    responses: Vec<Response>,
    busy: bool,
) -> (Vec<String>, Vec<String>, Option<Receipt>) {
    let server = Server::start(responses).await;
    let app = app(&server);
    let gate = UpdateGate::default();
    let directory: PathBuf =
        std::env::temp_dir().join(format!("updater-flow-{}", uuid::Uuid::new_v4()));
    let flow = UpdateFlow {
        updater: || app.updater_builder().no_proxy(),
        check_timeout: SHORT_TIMEOUT,
        download_timeout: GUARD_TIMEOUT,
        gate: &gate,
        directory: Some(&directory),
        current_version: "1.0.0",
    };
    let mut prompts = Prompts {
        log: server.log.clone(),
        busy: busy.then(|| gate.operation().unwrap()),
        retries: Vec::new(),
    };
    let installs = server.log.clone();
    tokio::time::timeout(GUARD_TIMEOUT * 4, async {
        let offered = flow.check().await.unwrap().expect("initial offer");
        flow.run(&offered.version, &mut prompts, |update, bytes| {
            assert_eq!(bytes, PAYLOAD, "only verified bytes reach the installer");
            installs.lock().unwrap().push(format!(
                "install {} from {}",
                update.version,
                update.download_url.path()
            ));
            Ok(())
        })
        .await;
    })
    .await
    .expect("update flow must finish before the test guard");
    let receipt = Receipt::take(&directory, "1.0.0")
        .unwrap()
        .map(|(receipt, result)| {
            assert_eq!(result, RestartResult::NotApplied);
            receipt
        });
    let _ = std::fs::remove_dir_all(&directory);
    let log = server.log.lock().unwrap().clone();
    (log, prompts.retries, receipt)
}

fn installed(target: &str) -> Option<Receipt> {
    Some(Receipt {
        from: "1.0.0".into(),
        target: target.into(),
    })
}

#[tokio::test]
async fn download_fetches_the_release_published_while_the_offer_was_open() {
    let (log, _, receipt) = run_flow(
        vec![
            Response::Release("99.0.1", "99.0.1"),
            // Published while "Update Available" was open.
            Response::Release("99.0.2", "99.0.2"),
            Response::Payload,
            Response::Release("99.0.2", "99.0.2"),
        ],
        false,
    )
    .await;
    assert_eq!(
        log,
        [
            "check",
            "offer 99.0.1",
            "check",
            "download /download/99.0.2",
            "approve 99.0.2",
            "check",
            "install 99.0.2 from /download/99.0.2",
        ]
    );
    assert_eq!(receipt, installed("99.0.2"));
}

#[tokio::test]
async fn install_now_replaces_a_release_changed_while_the_approval_was_open() {
    // A newer version, or the same version republished with different bytes.
    for (version, package) in [("99.0.2", "99.0.2"), ("99.0.1", "99.0.1-rebuilt")] {
        let (log, _, receipt) = run_flow(
            vec![
                Response::Release("99.0.1", "99.0.1"),
                Response::Release("99.0.1", "99.0.1"),
                Response::Payload,
                // Published while "Ready to install" was open.
                Response::Release(version, package),
                Response::Payload,
                Response::Release(version, package),
            ],
            false,
        )
        .await;
        assert_eq!(
            log,
            [
                "check".to_string(),
                "offer 99.0.1".into(),
                "check".into(),
                "download /download/99.0.1".into(),
                "approve 99.0.1".into(),
                "check".into(),
                format!("download /download/{package}"),
                // The earlier approval does not cover the replacement.
                format!("approve {version}"),
                "check".into(),
                format!("install {version} from /download/{package}"),
            ]
        );
        assert_eq!(receipt, installed(version));
    }
}

#[tokio::test]
async fn busy_retry_rechecks_and_reapproves_a_newer_release() {
    let (log, retries, receipt) = run_flow(
        vec![
            Response::Release("99.0.1", "99.0.1"),
            Response::Release("99.0.1", "99.0.1"),
            Response::Payload,
            Response::Release("99.0.1", "99.0.1"),
            // Published while "Update not started" was open.
            Response::Release("99.0.2", "99.0.2"),
            Response::Payload,
            Response::Release("99.0.2", "99.0.2"),
        ],
        true,
    )
    .await;
    assert_eq!(
        log,
        [
            "check",
            "offer 99.0.1",
            "check",
            "download /download/99.0.1",
            "approve 99.0.1",
            "check",
            "retry",
            "check",
            "download /download/99.0.2",
            "approve 99.0.2",
            "check",
            "install 99.0.2 from /download/99.0.2",
        ]
    );
    assert_eq!(retries.len(), 1);
    assert!(retries[0].contains("will not install while"), "{retries:?}");
    assert_eq!(receipt, installed("99.0.2"));
}

#[tokio::test]
async fn failed_or_empty_recheck_stops_without_stale_bytes() {
    for (failure, expected) in [
        (Response::Unavailable, "stop: check failed"),
        (Response::StallHeaders, "stop: check failed"),
        (Response::NoUpdate, "stop: no longer offered"),
    ] {
        // Recheck after Download: nothing is fetched.
        let (log, _, receipt) =
            run_flow(vec![Response::Release("99.0.2", "99.0.2"), failure], false).await;
        assert_eq!(log, ["check", "offer 99.0.2", "check", expected]);
        assert_eq!(receipt, None);
    }
    for (failure, expected) in [
        (Response::Unavailable, "stop: check failed"),
        (Response::StallHeaders, "stop: check failed"),
        (Response::NoUpdate, "stop: no longer offered"),
    ] {
        // Recheck after Install now: the verified bytes are not installed.
        let (log, _, receipt) = run_flow(
            vec![
                Response::Release("99.0.2", "99.0.2"),
                Response::Release("99.0.2", "99.0.2"),
                Response::Payload,
                failure,
            ],
            false,
        )
        .await;
        assert_eq!(
            log,
            [
                "check",
                "offer 99.0.2",
                "check",
                "download /download/99.0.2",
                "approve 99.0.2",
                "check",
                expected,
            ]
        );
        assert_eq!(receipt, None);
    }
}
