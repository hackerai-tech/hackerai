//! Optional receipts for the native authorization POST `send` stage.
//!
//! Kept independent of Tauri so it can be exercised with an actual reqwest
//! client against loopback fixtures. The v1 receipt holds only reqwest's public
//! error predicates, a bounded elapsed time, a fixed origin class and the
//! compiled target platform. The separate cause receipt holds only the closed
//! kind of the first `std::io::Error` in a bounded walk of the source chain.
//! Neither holds error text, URLs, identifiers, digests, bodies, headers,
//! hostnames or architecture.

use std::error::Error;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

const MAX_ELAPSED_MS: u64 = 60_000;
const MAX_SOURCE_LINKS: u8 = 8;

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

/// A transport class, not a claim about the customer's physical network.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IoKind {
    ConnectionReset,
    ConnectionAborted,
    BrokenPipe,
    UnexpectedEof,
    TimedOut,
    NotConnected,
    PermissionDenied,
    InvalidData,
    InvalidInput,
    Other,
    /// No `std::io::Error` within the observed links.
    NotExposed,
}

impl IoKind {
    fn from_io(kind: std::io::ErrorKind) -> Self {
        use std::io::ErrorKind;
        match kind {
            ErrorKind::ConnectionReset => Self::ConnectionReset,
            ErrorKind::ConnectionAborted => Self::ConnectionAborted,
            ErrorKind::BrokenPipe => Self::BrokenPipe,
            ErrorKind::UnexpectedEof => Self::UnexpectedEof,
            ErrorKind::TimedOut => Self::TimedOut,
            ErrorKind::NotConnected => Self::NotConnected,
            ErrorKind::PermissionDenied => Self::PermissionDenied,
            ErrorKind::InvalidData => Self::InvalidData,
            ErrorKind::InvalidInput => Self::InvalidInput,
            _ => Self::Other,
        }
    }
}

/// Sent on its own optional channel so the v1 receipt shape stays frozen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFailureCause {
    version: u8,
    io_kind: IoKind,
    /// Links walked: the IO error's depth when exposed, else the chain length.
    source_depth: u8,
    /// Another link existed beyond the last one observed.
    source_chain_truncated: bool,
}

fn bounded_elapsed_ms(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_millis())
        .unwrap_or(MAX_ELAPSED_MS)
        .min(MAX_ELAPSED_MS)
}

/// Walks at most `MAX_SOURCE_LINKS` sources of `error` (not `error` itself)
/// to the first `std::io::Error`. Only `source`, `downcast_ref` and the IO
/// error's `kind` are called: never `Display`, `Debug` or any other accessor.
fn send_failure_cause(error: &(dyn Error + 'static)) -> SendFailureCause {
    let cause = |io_kind, source_depth, source_chain_truncated| SendFailureCause {
        version: 1,
        io_kind,
        source_depth,
        source_chain_truncated,
    };
    let mut depth = 0;
    let mut source = error.source();
    while let Some(link) = source {
        if depth == MAX_SOURCE_LINKS {
            return cause(IoKind::NotExposed, depth, true);
        }
        depth += 1;
        if let Some(io) = link.downcast_ref::<std::io::Error>() {
            return cause(IoKind::from_io(io.kind()), depth, false);
        }
        source = link.source();
    }
    cause(IoKind::NotExposed, depth, false)
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
    F: FnOnce(SendFailureReceipt, SendFailureCause),
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
        let cause = send_failure_cause(error);
        let _ = catch_unwind(AssertUnwindSafe(|| observer(receipt, cause)));
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
        // Accept the request, then abort the connection with a reset.
        Reset,
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
                if let Fixture::Reset = fixture {
                    let mut head = [0u8; 5];
                    while let Ok(n) = socket.peek(&mut head).await {
                        if n == 0 || n == head.len() {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                    if &head == b"POST " {
                        counted.fetch_add(1, Ordering::SeqCst);
                    }
                    // A zero linger makes the close an abortive reset on every
                    // platform, rather than an orderly end of stream.
                    #[allow(deprecated)]
                    let _ = socket.set_linger(Some(Duration::ZERO));
                    drop(socket);
                    continue;
                }
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
                    Fixture::Reset => unreachable!(),
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

    type Recorded = Arc<Mutex<Vec<(SendFailureReceipt, SendFailureCause)>>>;

    fn recorder() -> (Recorded, impl FnOnce(SendFailureReceipt, SendFailureCause)) {
        let receipts = Arc::new(Mutex::new(Vec::new()));
        let recorded = receipts.clone();
        (receipts, move |receipt, cause| {
            recorded.lock().unwrap().push((receipt, cause))
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
            // Match the native request's existing budget: this case must
            // observe a refusal, not preempt it with a shorter fixture deadline.
            request(&url, Duration::from_secs(8)),
            OriginClass::OtherAllowed,
            Some(observer),
        )
        .await
        .expect_err("closed loopback port");
        let receipts = receipts.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        let (receipt, cause) = receipts[0];
        eprintln!(
            "authorization_refusal_fixture: timeout={} connect={} request={} elapsed_ms={} io_kind={:?} source_depth={}",
            receipt.timeout, receipt.connect, receipt.request, receipt.elapsed_ms,
            cause.io_kind, cause.source_depth
        );
        assert!(error.is_connect());
        // Refusal is outside the closed IO classes, but reqwest still exposes
        // its typed IO source within the bounded walk.
        assert_eq!(cause.io_kind, IoKind::Other);
        assert!((1..=MAX_SOURCE_LINKS).contains(&cause.source_depth));
        assert!(!cause.source_chain_truncated);
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
        let (receipt, cause) = receipts.lock().unwrap()[0];
        assert!(receipt.timeout);
        assert!((200..=MAX_ELAPSED_MS).contains(&receipt.elapsed_ms));
        // reqwest's own deadline is not an IO error; it must not be claimed as one.
        assert_eq!(cause.io_kind, IoKind::NotExposed);
        assert!(!cause.source_chain_truncated);
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
            Some(|_: SendFailureReceipt, _: SendFailureCause| panic!("observer failure")),
        )
        .await
        .expect_err("panic is contained");
        assert!(panicking.is_timeout());

        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);
        let closed = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            Some(move |receipt, cause| {
                let _ = sender.send((receipt, cause));
            }),
        )
        .await
        .expect_err("closed callback is ignored");
        assert!(closed.is_timeout());

        let direct = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            None::<fn(SendFailureReceipt, SendFailureCause)>,
        )
        .await
        .expect_err("direct path keeps the error");
        assert!(direct.is_timeout());

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn connection_reset_after_one_post_keeps_its_typed_io_cause() {
        let (url, posts) = serve(Fixture::Reset).await;
        let (receipts, observer) = recorder();
        let error = observed_send(
            request(&url, Duration::from_secs(2)),
            OriginClass::CanonicalProduction,
            Some(observer),
        )
        .await
        .expect_err("the fixture resets the connection");
        // The original reqwest error is returned, with its own predicates.
        assert!(!error.is_timeout());
        let receipts = receipts.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        let (receipt, cause) = receipts[0];
        assert_eq!(
            (receipt.timeout, receipt.connect, receipt.request),
            (error.is_timeout(), error.is_connect(), error.is_request())
        );
        // Depending on whether the reset beats the request write, the platform
        // reports a reset or an aborted write; both are the typed IO cause.
        assert!(
            matches!(
                cause.io_kind,
                IoKind::ConnectionReset | IoKind::ConnectionAborted | IoKind::BrokenPipe
            ),
            "{:?}",
            cause.io_kind
        );
        assert!((1..=MAX_SOURCE_LINKS).contains(&cause.source_depth));
        assert!(!cause.source_chain_truncated);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 1);
    }

    /// Display and Debug panic, so a walk that formats any link fails the test.
    struct Link(Option<Box<dyn Error + Send + Sync>>);

    impl std::fmt::Display for Link {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("Display exposes private error text")
        }
    }

    impl std::fmt::Debug for Link {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("Debug exposes private error text")
        }
    }

    impl Error for Link {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.0
                .as_deref()
                .map(|source| source as &(dyn Error + 'static))
        }
    }

    /// An error whose source is itself.
    struct Cycle;

    impl std::fmt::Display for Cycle {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("Display exposes private error text")
        }
    }

    impl std::fmt::Debug for Cycle {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("Debug exposes private error text")
        }
    }

    impl Error for Cycle {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&Cycle)
        }
    }

    /// A top-level error (not itself observed) above `links` opaque wrappers.
    fn chain(links: usize, tail: Option<Box<dyn Error + Send + Sync>>) -> Link {
        let mut source = tail;
        for _ in 0..links {
            source = Some(Box::new(Link(source)));
        }
        Link(source)
    }

    /// An IO error whose own text would panic if formatted.
    fn io(kind: std::io::ErrorKind) -> Option<Box<dyn Error + Send + Sync>> {
        Some(Box::new(std::io::Error::new(kind, Link(None))))
    }

    fn walk(error: &(dyn Error + 'static)) -> (IoKind, u8, bool) {
        let cause = send_failure_cause(error);
        assert_eq!(cause.version, 1);
        (
            cause.io_kind,
            cause.source_depth,
            cause.source_chain_truncated,
        )
    }

    #[test]
    fn send_failure_cause_finds_the_first_typed_io_error_without_formatting() {
        use std::io::ErrorKind;
        let reset = chain(0, io(ErrorKind::ConnectionReset));
        assert_eq!(walk(&reset), (IoKind::ConnectionReset, 1, false));
        // Nested beneath opaque wrappers, as hyper and reqwest wrap transport IO.
        let eof = chain(3, io(ErrorKind::UnexpectedEof));
        assert_eq!(walk(&eof), (IoKind::UnexpectedEof, 4, false));
        // The first exposed IO error wins over a deeper one.
        let nested = chain(
            1,
            Some(Box::new(std::io::Error::new(
                ErrorKind::TimedOut,
                chain(0, io(ErrorKind::BrokenPipe)),
            ))),
        );
        assert_eq!(walk(&nested), (IoKind::TimedOut, 2, false));
        // Opaque, non-IO causes are reported as not exposed with their length.
        assert_eq!(walk(&chain(0, None)), (IoKind::NotExposed, 0, false));
        assert_eq!(walk(&chain(3, None)), (IoKind::NotExposed, 3, false));
        let os = chain(
            1,
            Some(Box::new(std::io::Error::from(ErrorKind::NotConnected))),
        );
        assert_eq!(walk(&os), (IoKind::NotConnected, 2, false));
    }

    #[test]
    fn send_failure_cause_walk_is_bounded_and_survives_cycles() {
        use std::io::ErrorKind;
        // The eighth link is the last one observed.
        let last = chain(7, io(ErrorKind::ConnectionReset));
        assert_eq!(walk(&last), (IoKind::ConnectionReset, 8, false));
        assert_eq!(walk(&chain(8, None)), (IoKind::NotExposed, 8, false));
        // A ninth link is never inspected, even when it is an IO error.
        let beyond = chain(8, io(ErrorKind::ConnectionReset));
        assert_eq!(walk(&beyond), (IoKind::NotExposed, 8, true));
        assert_eq!(walk(&Cycle), (IoKind::NotExposed, 8, true));
        let cycle_below = chain(2, Some(Box::new(Link(Some(Box::new(Cycle))))));
        assert_eq!(walk(&cycle_below), (IoKind::NotExposed, 8, true));
    }

    #[test]
    fn send_failure_cause_maps_io_kinds_to_a_closed_class() {
        use std::io::ErrorKind;
        for (kind, class) in [
            (ErrorKind::ConnectionReset, IoKind::ConnectionReset),
            (ErrorKind::ConnectionAborted, IoKind::ConnectionAborted),
            (ErrorKind::BrokenPipe, IoKind::BrokenPipe),
            (ErrorKind::UnexpectedEof, IoKind::UnexpectedEof),
            (ErrorKind::TimedOut, IoKind::TimedOut),
            (ErrorKind::NotConnected, IoKind::NotConnected),
            (ErrorKind::PermissionDenied, IoKind::PermissionDenied),
            (ErrorKind::InvalidData, IoKind::InvalidData),
            (ErrorKind::InvalidInput, IoKind::InvalidInput),
            (ErrorKind::Other, IoKind::Other),
            (ErrorKind::ConnectionRefused, IoKind::Other),
            (ErrorKind::WouldBlock, IoKind::Other),
            (ErrorKind::NotFound, IoKind::Other),
        ] {
            assert_eq!(walk(&chain(0, io(kind))).0, class, "{kind:?}");
        }
    }

    #[test]
    fn cause_receipt_serializes_only_its_closed_schema() {
        let wire = serde_json::to_value(send_failure_cause(&chain(
            2,
            io(std::io::ErrorKind::ConnectionReset),
        )))
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "version": 1,
                "ioKind": "connection_reset",
                "sourceDepth": 3,
                "sourceChainTruncated": false,
            })
        );
        let wire = serde_json::to_value(send_failure_cause(&Cycle)).unwrap();
        assert_eq!(wire["ioKind"], "not_exposed");
        assert_eq!(wire["sourceChainTruncated"], true);
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
