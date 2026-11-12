//! Optional receipt for the native authorization POST `send` stage.
//!
//! Kept independent of Tauri so it can be exercised with an actual reqwest
//! client against loopback fixtures. A receipt holds only reqwest's public error
//! predicates, a bounded elapsed time, a fixed origin class and the compiled
//! target platform: never error text, source chains, URLs, identifiers,
//! digests, bodies, headers, hostnames or architecture.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

const MAX_ELAPSED_MS: u64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginClass {
    CanonicalProduction,
    Localhost,
    OtherAllowed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum Platform {
    Darwin,
    Linux,
    Windows,
    Unknown,
}

impl Platform {
    fn from_target_os(os: &str) -> Self {
        match os {
            "macos" => Self::Darwin,
            "linux" => Self::Linux,
            "windows" => Self::Windows,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFailureReceipt {
    version: u8,
    // reqwest's predicates are independent and may overlap.
    timeout: bool,
    connect: bool,
    request: bool,
    elapsed_ms: u64,
    origin_class: OriginClass,
    platform: Platform,
}

fn bounded_elapsed_ms(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_millis())
        .unwrap_or(MAX_ELAPSED_MS)
        .min(MAX_ELAPSED_MS)
}

/// Sends `request` exactly once and returns reqwest's original result.
///
/// Only a send error is reported, once, before that error is returned. Without
/// an observer this is the direct send. The observer cannot retry, delay beyond
/// its own call or change the result. Panic containment applies to unwinding
/// builds only; release builds abort, so the production observer must not
/// panic (it ignores channel send failures).
pub async fn observed_send<F>(
    request: reqwest::RequestBuilder,
    origin_class: OriginClass,
    observer: Option<F>,
) -> reqwest::Result<reqwest::Response>
where
    F: FnOnce(SendFailureReceipt),
{
    let Some(observer) = observer else {
        return request.send().await;
    };
    let started = Instant::now();
    let result = request.send().await;
    if let Err(error) = &result {
        let receipt = SendFailureReceipt {
            version: 1,
            timeout: error.is_timeout(),
            connect: error.is_connect(),
            request: error.is_request(),
            elapsed_ms: bounded_elapsed_ms(started.elapsed()),
            origin_class,
            platform: Platform::from_target_os(std::env::consts::OS),
        };
        let _ = catch_unwind(AssertUnwindSafe(|| observer(receipt)));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone, Copy)]
    enum Fixture {
        Status(u16),
        // Accept and read the request, then never answer.
        LostResponse,
    }

    /// A synthetic loopback endpoint that counts POST requests.
    async fn serve(fixture: Fixture) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/api/desktop/authorized-operation",
            listener.local_addr().unwrap()
        );
        let posts = Arc::new(AtomicUsize::new(0));
        let counted = posts.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buffer[..n]),
                    }
                }
                if request.starts_with(b"POST ") {
                    counted.fetch_add(1, Ordering::SeqCst);
                }
                match fixture {
                    Fixture::Status(status) => {
                        let response = format!(
                            "HTTP/1.1 {status} Fixture\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                    }
                    Fixture::LostResponse => {
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                            drop(socket);
                        });
                    }
                }
            }
        });
        (url, posts)
    }

    async fn refused_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}/api/desktop/authorized-operation")
    }

    fn request(url: &str, timeout: Duration) -> reqwest::RequestBuilder {
        reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
            .post(url)
            .json(&serde_json::json!({ "id": "synthetic", "digest": "synthetic" }))
    }

    fn recorder() -> (
        Arc<Mutex<Vec<SendFailureReceipt>>>,
        impl FnOnce(SendFailureReceipt),
    ) {
        let receipts = Arc::new(Mutex::new(Vec::new()));
        let recorded = receipts.clone();
        (receipts, move |receipt| {
            recorded.lock().unwrap().push(receipt)
        })
    }

    #[tokio::test]
    async fn http_statuses_are_returned_without_a_receipt() {
        for status in [200, 503] {
            let (url, posts) = serve(Fixture::Status(status)).await;
            let (receipts, observer) = recorder();
            let response = observed_send(
                request(&url, Duration::from_secs(2)),
                OriginClass::Localhost,
                Some(observer),
            )
            .await
            .expect("an HTTP status is not a send failure");
            assert_eq!(response.status().as_u16(), status);
            assert!(receipts.lock().unwrap().is_empty());
            assert_eq!(posts.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn connection_refusal_reports_one_bounded_public_receipt() {
        let url = refused_url().await;
        let (receipts, observer) = recorder();
        let error = observed_send(
            request(&url, Duration::from_secs(2)),
            OriginClass::OtherAllowed,
            Some(observer),
        )
        .await
        .expect_err("closed loopback port");
        assert!(error.is_connect());
        let receipts = receipts.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        let receipt = receipts[0];
        assert_eq!(
            (receipt.version, receipt.connect, receipt.timeout),
            (1, true, false)
        );
        assert_eq!(receipt.request, error.is_request());
        assert_eq!(receipt.origin_class, OriginClass::OtherAllowed);
        assert!(receipt.elapsed_ms <= MAX_ELAPSED_MS);

        // The serialized receipt is exactly the closed schema parsed by the web.
        let wire = serde_json::to_value(receipt).unwrap();
        let mut keys: Vec<_> = wire.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "connect",
                "elapsedMs",
                "originClass",
                "platform",
                "request",
                "timeout",
                "version"
            ]
        );
        assert_eq!(wire["originClass"], "other_allowed");
        let expected_platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "unknown"
        };
        assert_eq!(wire["platform"], expected_platform);
        assert!(!wire.to_string().contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn lost_response_timeout_reports_after_exactly_one_post() {
        let (url, posts) = serve(Fixture::LostResponse).await;
        let (receipts, observer) = recorder();
        let error = observed_send(
            request(&url, Duration::from_millis(250)),
            OriginClass::Localhost,
            Some(observer),
        )
        .await
        .expect_err("the fixture never answers");
        assert!(error.is_timeout());
        let receipt = receipts.lock().unwrap()[0];
        assert!(receipt.timeout);
        assert!((200..=MAX_ELAPSED_MS).contains(&receipt.elapsed_ms));
        // Give an unexpected retry time to arrive before counting.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        assert_eq!(receipts.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn observer_failures_and_absence_keep_the_original_single_send() {
        let (url, posts) = serve(Fixture::LostResponse).await;
        let panicking = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            Some(|_: SendFailureReceipt| panic!("observer failure")),
        )
        .await
        .expect_err("panic is contained");
        assert!(panicking.is_timeout());

        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);
        let closed = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            Some(move |receipt| {
                let _ = sender.send(receipt);
            }),
        )
        .await
        .expect_err("closed callback is ignored");
        assert!(closed.is_timeout());

        let direct = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            None::<fn(SendFailureReceipt)>,
        )
        .await
        .expect_err("direct path keeps the error");
        assert!(direct.is_timeout());

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn elapsed_time_is_bounded() {
        assert_eq!(bounded_elapsed_ms(Duration::ZERO), 0);
        assert_eq!(bounded_elapsed_ms(Duration::from_millis(60_000)), 60_000);
        assert_eq!(bounded_elapsed_ms(Duration::from_millis(60_001)), 60_000);
        assert_eq!(bounded_elapsed_ms(Duration::MAX), 60_000);
    }

    #[test]
    fn platform_is_a_closed_class_of_the_target_os() {
        for (os, platform) in [
            ("macos", Platform::Darwin),
            ("linux", Platform::Linux),
            ("windows", Platform::Windows),
            ("darwin", Platform::Unknown),
            ("macOS", Platform::Unknown),
            ("ios", Platform::Unknown),
            ("freebsd", Platform::Unknown),
            ("", Platform::Unknown),
        ] {
            assert_eq!(Platform::from_target_os(os), platform, "{os}");
        }
    }
}
