use super::check_update;
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
    Manifest,
    Payload,
    TamperedPayload,
}

struct Server {
    endpoint: url::Url,
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
        let download_url = endpoint.join("/download").unwrap();
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
                    Response::NoUpdate => {
                        stream
                            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                            .await
                            .unwrap();
                        continue;
                    }
                    Response::Manifest => serde_json::json!({
                        "version": "99.0.0",
                        "url": download_url,
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
        Self { endpoint, task }
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
        let server = Server::start(vec![Response::Manifest, stall, Response::Payload]).await;
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
    let server = Server::start(vec![Response::Manifest, Response::TamperedPayload]).await;
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
