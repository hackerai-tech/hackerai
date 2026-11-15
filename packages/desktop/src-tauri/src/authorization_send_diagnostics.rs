//! Optional receipts for the native authorization POST `send` stage.
//!
//! Kept independent of Tauri so it can be exercised with an actual reqwest
//! client against loopback fixtures. The v1 receipt holds only reqwest's public
//! error predicates, a bounded elapsed time, a fixed origin class and the
//! compiled target platform. The separate cause receipt holds only the closed
//! kind of the first `std::io::Error` in a bounded walk of the source chain.
//! The separate transport detail splits that kind without the cause's `Other`
//! fold and records whether a typed `native_tls::Error` was observed. When
//! that first IO error's detail is `Unmapped`, a separate supplement splits
//! its remaining stable kind and a closed family of its own OS code. None of
//! them hold error text, URLs, identifiers, digests, bodies, headers,
//! hostnames, certificate details, raw OS codes or architecture.

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

/// The first IO error's own kind. Known kinds keep their name, `Other` is only
/// `ErrorKind::Other` itself, and every remaining kind is `Unmapped`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IoKindDetail {
    ConnectionRefused,
    ConnectionReset,
    ConnectionAborted,
    HostUnreachable,
    NetworkUnreachable,
    NetworkDown,
    AddrInUse,
    AddrNotAvailable,
    BrokenPipe,
    UnexpectedEof,
    TimedOut,
    NotConnected,
    PermissionDenied,
    InvalidData,
    InvalidInput,
    WouldBlock,
    Interrupted,
    Unsupported,
    OutOfMemory,
    Other,
    Unmapped,
    /// No `std::io::Error` within the observed links.
    NotExposed,
}

impl IoKindDetail {
    fn from_io(kind: std::io::ErrorKind) -> Self {
        use std::io::ErrorKind;
        match kind {
            ErrorKind::ConnectionRefused => Self::ConnectionRefused,
            ErrorKind::ConnectionReset => Self::ConnectionReset,
            ErrorKind::ConnectionAborted => Self::ConnectionAborted,
            ErrorKind::HostUnreachable => Self::HostUnreachable,
            ErrorKind::NetworkUnreachable => Self::NetworkUnreachable,
            ErrorKind::NetworkDown => Self::NetworkDown,
            ErrorKind::AddrInUse => Self::AddrInUse,
            ErrorKind::AddrNotAvailable => Self::AddrNotAvailable,
            ErrorKind::BrokenPipe => Self::BrokenPipe,
            ErrorKind::UnexpectedEof => Self::UnexpectedEof,
            ErrorKind::TimedOut => Self::TimedOut,
            ErrorKind::NotConnected => Self::NotConnected,
            ErrorKind::PermissionDenied => Self::PermissionDenied,
            ErrorKind::InvalidData => Self::InvalidData,
            ErrorKind::InvalidInput => Self::InvalidInput,
            ErrorKind::WouldBlock => Self::WouldBlock,
            ErrorKind::Interrupted => Self::Interrupted,
            ErrorKind::Unsupported => Self::Unsupported,
            ErrorKind::OutOfMemory => Self::OutOfMemory,
            ErrorKind::Other => Self::Other,
            _ => Self::Unmapped,
        }
    }
}

/// Sent on its own optional channel so the cause receipt's buckets are frozen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTransportDetail {
    version: u8,
    io_kind_detail: IoKindDetail,
    /// A typed `native_tls::Error` was an observed link or the first IO
    /// error's inner error. Not a certificate reason or the failure's origin.
    native_tls_source: bool,
    /// Links observed, at most `MAX_SOURCE_LINKS`.
    source_depth: u8,
    /// Another link existed beyond the last one observed.
    source_chain_truncated: bool,
    /// Derived from the same first IO error, only when it is `Unmapped`. Never
    /// serialized here, so this receipt's wire shape stays frozen.
    #[serde(skip)]
    io_supplement: Option<SendIoSupplement>,
}

impl SendTransportDetail {
    /// The supplement for its own optional channel, as a copied value.
    pub fn io_supplement(&self) -> Option<SendIoSupplement> {
        self.io_supplement
    }
}

/// The stable kinds that `IoKindDetail` leaves `Unmapped`. `Unknown` is every
/// other kind, including std's unstable `Uncategorized` and future kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnmappedIoKind {
    NotFound,
    AlreadyExists,
    WriteZero,
    NotADirectory,
    IsADirectory,
    DirectoryNotEmpty,
    ReadOnlyFilesystem,
    StaleNetworkFileHandle,
    StorageFull,
    NotSeekable,
    QuotaExceeded,
    FileTooLarge,
    ResourceBusy,
    ExecutableFileBusy,
    Deadlock,
    CrossesDevices,
    TooManyLinks,
    InvalidFilename,
    ArgumentListTooLong,
    Unknown,
}

impl UnmappedIoKind {
    fn from_io(kind: std::io::ErrorKind) -> Self {
        use std::io::ErrorKind;
        match kind {
            ErrorKind::NotFound => Self::NotFound,
            ErrorKind::AlreadyExists => Self::AlreadyExists,
            ErrorKind::WriteZero => Self::WriteZero,
            ErrorKind::NotADirectory => Self::NotADirectory,
            ErrorKind::IsADirectory => Self::IsADirectory,
            ErrorKind::DirectoryNotEmpty => Self::DirectoryNotEmpty,
            ErrorKind::ReadOnlyFilesystem => Self::ReadOnlyFilesystem,
            ErrorKind::StaleNetworkFileHandle => Self::StaleNetworkFileHandle,
            ErrorKind::StorageFull => Self::StorageFull,
            ErrorKind::NotSeekable => Self::NotSeekable,
            ErrorKind::QuotaExceeded => Self::QuotaExceeded,
            ErrorKind::FileTooLarge => Self::FileTooLarge,
            ErrorKind::ResourceBusy => Self::ResourceBusy,
            ErrorKind::ExecutableFileBusy => Self::ExecutableFileBusy,
            ErrorKind::Deadlock => Self::Deadlock,
            ErrorKind::CrossesDevices => Self::CrossesDevices,
            ErrorKind::TooManyLinks => Self::TooManyLinks,
            ErrorKind::InvalidFilename => Self::InvalidFilename,
            ErrorKind::ArgumentListTooLong => Self::ArgumentListTooLong,
            _ => Self::Unknown,
        }
    }
}

/// A closed family of the IO error's own stored OS code, never the code
/// itself. Only the Windows Sockets name-resolution codes are named, and only
/// in a Windows build, because the same numbers mean nothing (or something
/// else) elsewhere. See Microsoft's Windows Sockets Error Codes:
/// https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2
/// A family is the code std recorded, not proof of the physical cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OsFamily {
    /// WSAHOST_NOT_FOUND (11001).
    WinsockHostNotFound,
    /// WSATRY_AGAIN (11002).
    WinsockTryAgain,
    /// WSANO_RECOVERY (11003).
    WinsockNoRecovery,
    /// WSANO_DATA (11004).
    WinsockNoData,
    OtherWindowsOsCode,
    NoRawOsCode,
    NotWindows,
}

impl OsFamily {
    /// Reads only the value `io::Error::raw_os_error` returned for that error,
    /// never the thread's last OS error.
    fn classify(raw_os_error: Option<i32>, compiled_windows: bool) -> Self {
        if !compiled_windows {
            return Self::NotWindows;
        }
        match raw_os_error {
            None => Self::NoRawOsCode,
            Some(11001) => Self::WinsockHostNotFound,
            Some(11002) => Self::WinsockTryAgain,
            Some(11003) => Self::WinsockNoRecovery,
            Some(11004) => Self::WinsockNoData,
            Some(_) => Self::OtherWindowsOsCode,
        }
    }
}

/// Sent on its own optional channel so the transport detail's v1 wire shape
/// and buckets are frozen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendIoSupplement {
    version: u8,
    io_kind: UnmappedIoKind,
    os_family: OsFamily,
    /// The first IO error's depth, 1..=`MAX_SOURCE_LINKS`.
    source_depth: u8,
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

/// Walks at most `MAX_SOURCE_LINKS` sources of `error` (not `error` itself),
/// all of them rather than stopping at the first `std::io::Error`. Only
/// `source`, type checks and that IO error's `kind`, `get_ref` and (only when
/// `Unmapped`) `raw_os_error` are called: never `Display`, `Debug` or any
/// other accessor. `io::Error::source` skips a custom inner error, so that
/// inner error's type is checked directly.
fn send_transport_detail(error: &(dyn Error + 'static)) -> SendTransportDetail {
    let mut io_kind_detail = None;
    let mut io_supplement = None;
    let mut native_tls_source = false;
    let mut source_depth = 0;
    let mut source_chain_truncated = false;
    let mut source = error.source();
    while let Some(link) = source {
        if source_depth == MAX_SOURCE_LINKS {
            source_chain_truncated = true;
            break;
        }
        source_depth += 1;
        native_tls_source |= link.is::<native_tls::Error>();
        if io_kind_detail.is_none() {
            if let Some(io) = link.downcast_ref::<std::io::Error>() {
                let kind = io.kind();
                let detail = IoKindDetail::from_io(kind);
                io_kind_detail = Some(detail);
                if detail == IoKindDetail::Unmapped {
                    io_supplement = Some(SendIoSupplement {
                        version: 1,
                        io_kind: UnmappedIoKind::from_io(kind),
                        os_family: OsFamily::classify(io.raw_os_error(), cfg!(windows)),
                        source_depth,
                    });
                }
                native_tls_source |= io
                    .get_ref()
                    .is_some_and(|inner| inner.is::<native_tls::Error>());
            }
        }
        source = link.source();
    }
    SendTransportDetail {
        version: 1,
        io_kind_detail: io_kind_detail.unwrap_or(IoKindDetail::NotExposed),
        native_tls_source,
        source_depth,
        source_chain_truncated,
        io_supplement,
    }
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
    F: FnOnce(SendFailureReceipt, SendFailureCause, SendTransportDetail),
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
        let detail = send_transport_detail(error);
        let _ = catch_unwind(AssertUnwindSafe(|| observer(receipt, cause, detail)));
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

    /// A plaintext HTTP endpoint behind an `https` URL. The client's own TLS
    /// handshake fails on the non-TLS answer before any certificate is
    /// presented, so validation keeps its defaults. Counts connections.
    async fn plaintext_https_url() -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "https://{}/api/desktop/authorized-operation",
            listener.local_addr().unwrap()
        );
        let connections = Arc::new(AtomicUsize::new(0));
        let counted = connections.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = socket.read(&mut buffer).await;
                    let response = b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n";
                    let _ = socket.write_all(response).await;
                    let _ = socket.shutdown().await;
                    // Drain until the client gives up, so the close is orderly.
                    let _ = tokio::time::timeout(Duration::from_secs(5), async {
                        while let Ok(n) = socket.read(&mut buffer).await {
                            if n == 0 {
                                break;
                            }
                        }
                    })
                    .await;
                });
            }
        });
        (url, connections)
    }

    type Recorded = Arc<Mutex<Vec<(SendFailureReceipt, SendFailureCause, SendTransportDetail)>>>;

    fn recorder() -> (
        Recorded,
        impl FnOnce(SendFailureReceipt, SendFailureCause, SendTransportDetail),
    ) {
        let receipts = Arc::new(Mutex::new(Vec::new()));
        let recorded = receipts.clone();
        (receipts, move |receipt, cause, detail| {
            recorded.lock().unwrap().push((receipt, cause, detail))
        })
    }

    /// The frozen cause bucket that every detail must still fall into.
    fn legacy_bucket(detail: IoKindDetail) -> IoKind {
        match detail {
            IoKindDetail::ConnectionReset => IoKind::ConnectionReset,
            IoKindDetail::ConnectionAborted => IoKind::ConnectionAborted,
            IoKindDetail::BrokenPipe => IoKind::BrokenPipe,
            IoKindDetail::UnexpectedEof => IoKind::UnexpectedEof,
            IoKindDetail::TimedOut => IoKind::TimedOut,
            IoKindDetail::NotConnected => IoKind::NotConnected,
            IoKindDetail::PermissionDenied => IoKind::PermissionDenied,
            IoKindDetail::InvalidData => IoKind::InvalidData,
            IoKindDetail::InvalidInput => IoKind::InvalidInput,
            IoKindDetail::NotExposed => IoKind::NotExposed,
            _ => IoKind::Other,
        }
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
        let (receipt, cause, detail) = receipts[0];
        eprintln!(
            "authorization_refusal_fixture: timeout={} connect={} request={} elapsed_ms={} io_kind={:?} source_depth={} io_kind_detail={:?} native_tls_source={} detail_source_depth={} detail_truncated={}",
            receipt.timeout, receipt.connect, receipt.request, receipt.elapsed_ms,
            cause.io_kind, cause.source_depth, detail.io_kind_detail,
            detail.native_tls_source, detail.source_depth, detail.source_chain_truncated
        );
        assert!(error.is_connect());
        // Refusal is outside the closed IO classes, but reqwest still exposes
        // its typed IO source within the bounded walk.
        assert_eq!(cause.io_kind, IoKind::Other);
        assert!((1..=MAX_SOURCE_LINKS).contains(&cause.source_depth));
        assert!(!cause.source_chain_truncated);
        // The detail names the same IO error that the cause folds into Other.
        assert_eq!(detail.version, 1);
        assert_eq!(detail.io_kind_detail, IoKindDetail::ConnectionRefused);
        assert!(!detail.native_tls_source);
        assert!(detail.source_depth >= cause.source_depth);
        assert!(detail.source_depth <= MAX_SOURCE_LINKS);
        assert!(!detail.source_chain_truncated);
        let wire = serde_json::to_value(detail).unwrap();
        assert_eq!(wire["ioKindDetail"], "connection_refused");
        assert!(!wire.to_string().contains("127.0.0.1"));
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
        let (receipt, cause, detail) = receipts.lock().unwrap()[0];
        assert!(receipt.timeout);
        assert!((200..=MAX_ELAPSED_MS).contains(&receipt.elapsed_ms));
        // reqwest's own deadline is not an IO error; it must not be claimed as one.
        assert_eq!(cause.io_kind, IoKind::NotExposed);
        assert!(!cause.source_chain_truncated);
        assert_eq!(detail.io_kind_detail, IoKindDetail::NotExposed);
        assert!(!detail.native_tls_source);
        assert!(!detail.source_chain_truncated);
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
            Some(
                |_: SendFailureReceipt, _: SendFailureCause, _: SendTransportDetail| {
                    panic!("observer failure")
                },
            ),
        )
        .await
        .expect_err("panic is contained");
        assert!(panicking.is_timeout());

        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);
        let closed = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            Some(move |receipt, cause, detail| {
                let _ = sender.send((receipt, cause, detail));
            }),
        )
        .await
        .expect_err("closed callback is ignored");
        assert!(closed.is_timeout());

        let direct = observed_send(
            request(&url, Duration::from_millis(100)),
            OriginClass::Localhost,
            None::<fn(SendFailureReceipt, SendFailureCause, SendTransportDetail)>,
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
        let (receipt, cause, detail) = receipts[0];
        assert_eq!(
            (receipt.timeout, receipt.connect, receipt.request),
            (error.is_timeout(), error.is_connect(), error.is_request())
        );
        // The same first IO error, still in its frozen cause bucket.
        assert_eq!(legacy_bucket(detail.io_kind_detail), cause.io_kind);
        assert!(!detail.native_tls_source);
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

    #[tokio::test]
    async fn failed_tls_handshake_reports_a_typed_native_tls_source() {
        let (url, connections) = plaintext_https_url().await;
        let (receipts, observer) = recorder();
        let error = observed_send(
            // The production client's TLS defaults; only proxies are disabled.
            request(&url, Duration::from_secs(8)),
            OriginClass::Localhost,
            Some(observer),
        )
        .await
        .expect_err("a plaintext answer cannot complete a TLS handshake");
        let receipts = receipts.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        let (receipt, cause, detail) = receipts[0];
        eprintln!(
            "authorization_tls_fixture: timeout={} connect={} request={} io_kind={:?} source_depth={} io_kind_detail={:?} native_tls_source={} detail_source_depth={} detail_truncated={}",
            receipt.timeout, receipt.connect, receipt.request, cause.io_kind,
            cause.source_depth, detail.io_kind_detail, detail.native_tls_source,
            detail.source_depth, detail.source_chain_truncated
        );
        assert!(!error.is_timeout());
        assert_eq!(
            (receipt.timeout, receipt.connect, receipt.request),
            (error.is_timeout(), error.is_connect(), error.is_request())
        );
        assert!(detail.native_tls_source);
        assert!((1..=MAX_SOURCE_LINKS).contains(&detail.source_depth));
        assert!(!detail.source_chain_truncated);
        // Whatever IO kind the platform exposes, the cause keeps its bucket.
        assert_eq!(legacy_bucket(detail.io_kind_detail), cause.io_kind);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(connections.load(Ordering::SeqCst), 1);
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

    fn detail(error: &(dyn Error + 'static)) -> (IoKindDetail, bool, u8, bool) {
        let detail = send_transport_detail(error);
        assert_eq!(detail.version, 1);
        (
            detail.io_kind_detail,
            detail.native_tls_source,
            detail.source_depth,
            detail.source_chain_truncated,
        )
    }

    /// A typed TLS error from a local parse; no network or certificate trust.
    fn tls() -> native_tls::Error {
        match native_tls::Certificate::from_der(&[]) {
            Err(error) => error,
            Ok(_) => panic!("an empty certificate must not parse"),
        }
    }

    #[test]
    fn transport_detail_splits_io_kinds_without_changing_the_cause_bucket() {
        use std::io::ErrorKind;
        for (kind, expected) in [
            (
                ErrorKind::ConnectionRefused,
                IoKindDetail::ConnectionRefused,
            ),
            (ErrorKind::ConnectionReset, IoKindDetail::ConnectionReset),
            (
                ErrorKind::ConnectionAborted,
                IoKindDetail::ConnectionAborted,
            ),
            (ErrorKind::HostUnreachable, IoKindDetail::HostUnreachable),
            (
                ErrorKind::NetworkUnreachable,
                IoKindDetail::NetworkUnreachable,
            ),
            (ErrorKind::NetworkDown, IoKindDetail::NetworkDown),
            (ErrorKind::AddrInUse, IoKindDetail::AddrInUse),
            (ErrorKind::AddrNotAvailable, IoKindDetail::AddrNotAvailable),
            (ErrorKind::BrokenPipe, IoKindDetail::BrokenPipe),
            (ErrorKind::UnexpectedEof, IoKindDetail::UnexpectedEof),
            (ErrorKind::TimedOut, IoKindDetail::TimedOut),
            (ErrorKind::NotConnected, IoKindDetail::NotConnected),
            (ErrorKind::PermissionDenied, IoKindDetail::PermissionDenied),
            (ErrorKind::InvalidData, IoKindDetail::InvalidData),
            (ErrorKind::InvalidInput, IoKindDetail::InvalidInput),
            (ErrorKind::WouldBlock, IoKindDetail::WouldBlock),
            (ErrorKind::Interrupted, IoKindDetail::Interrupted),
            (ErrorKind::Unsupported, IoKindDetail::Unsupported),
            (ErrorKind::OutOfMemory, IoKindDetail::OutOfMemory),
            // Only the actual Other kind is Other; the rest stay distinct.
            (ErrorKind::Other, IoKindDetail::Other),
            (ErrorKind::NotFound, IoKindDetail::Unmapped),
            (ErrorKind::AlreadyExists, IoKindDetail::Unmapped),
            (ErrorKind::WriteZero, IoKindDetail::Unmapped),
        ] {
            let error = chain(2, io(kind));
            assert_eq!(detail(&error), (expected, false, 3, false), "{kind:?}");
            assert_eq!(legacy_bucket(expected), walk(&error).0, "{kind:?}");
        }
        // An OS error that std leaves uncategorized is residual, not Other.
        let raw = chain(0, Some(Box::new(std::io::Error::from_raw_os_error(-1))));
        assert_eq!(detail(&raw).0, IoKindDetail::Unmapped);
        assert_eq!(walk(&raw).0, IoKind::Other);
    }

    #[test]
    fn transport_detail_finds_only_a_typed_native_tls_error() {
        use std::io::ErrorKind;
        // A typed link beneath opaque wrappers, with no IO error. The TLS
        // error's own sources depend on the platform backend.
        let wrapped = chain(2, Some(Box::new(tls())));
        let (kind, native_tls_source, depth, truncated) = detail(&wrapped);
        assert_eq!(
            (kind, native_tls_source, truncated),
            (IoKindDetail::NotExposed, true, false)
        );
        assert!((3..=MAX_SOURCE_LINKS).contains(&depth));
        assert_eq!(
            detail(&chain(2, None)),
            (IoKindDetail::NotExposed, false, 2, false)
        );
        // The first IO error's custom inner error, which `source` skips.
        let inner = chain(
            1,
            Some(Box::new(std::io::Error::new(ErrorKind::Other, tls()))),
        );
        let (kind, native_tls_source, depth, _) = detail(&inner);
        assert_eq!((kind, native_tls_source), (IoKindDetail::Other, true));
        assert!((2..=MAX_SOURCE_LINKS).contains(&depth));
        assert_eq!(walk(&inner).0, IoKind::Other);
        // Beneath the first IO error, which still names the kind.
        let below = chain(
            0,
            Some(Box::new(std::io::Error::new(
                ErrorKind::ConnectionReset,
                Link(Some(Box::new(tls()))),
            ))),
        );
        let (kind, native_tls_source, ..) = detail(&below);
        assert_eq!(
            (kind, native_tls_source),
            (IoKindDetail::ConnectionReset, true)
        );
        // Error text is never read, so TLS-like words are not a TLS witness.
        let words = chain(
            1,
            Some(Box::new(std::io::Error::new(
                ErrorKind::Other,
                "tls handshake certificate proxy",
            ))),
        );
        assert_eq!(detail(&words), (IoKindDetail::Other, false, 2, false));
        // A ninth link is never inspected, even when it is a TLS error.
        let beyond = chain(8, Some(Box::new(tls())));
        assert_eq!(detail(&beyond), (IoKindDetail::NotExposed, false, 8, true));
    }

    #[test]
    fn transport_detail_walk_is_bounded_and_survives_cycles() {
        use std::io::ErrorKind;
        assert_eq!(
            detail(&chain(0, None)),
            (IoKindDetail::NotExposed, false, 0, false)
        );
        // Links after the first IO error are still counted, up to the bound.
        let deeper = chain(
            0,
            Some(Box::new(std::io::Error::new(
                ErrorKind::TimedOut,
                chain(2, io(ErrorKind::BrokenPipe)),
            ))),
        );
        assert_eq!(detail(&deeper), (IoKindDetail::TimedOut, false, 4, false));
        let last = chain(7, io(ErrorKind::ConnectionRefused));
        assert_eq!(
            detail(&last),
            (IoKindDetail::ConnectionRefused, false, 8, false)
        );
        assert_eq!(
            detail(&chain(8, None)),
            (IoKindDetail::NotExposed, false, 8, false)
        );
        let beyond = chain(8, io(ErrorKind::ConnectionRefused));
        assert_eq!(detail(&beyond), (IoKindDetail::NotExposed, false, 8, true));
        // An exposed kind can still have more links than the walk observes.
        let long = chain(
            0,
            Some(Box::new(std::io::Error::new(
                ErrorKind::ConnectionRefused,
                chain(9, None),
            ))),
        );
        assert_eq!(
            detail(&long),
            (IoKindDetail::ConnectionRefused, false, 8, true)
        );
        assert_eq!(detail(&Cycle), (IoKindDetail::NotExposed, false, 8, true));
    }

    #[test]
    fn transport_detail_serializes_only_its_closed_schema() {
        let wire = serde_json::to_value(send_transport_detail(&chain(
            1,
            io(std::io::ErrorKind::AddrNotAvailable),
        )))
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "version": 1,
                "ioKindDetail": "addr_not_available",
                "nativeTlsSource": false,
                "sourceDepth": 2,
                "sourceChainTruncated": false,
            })
        );
        let wire =
            serde_json::to_value(send_transport_detail(&Link(Some(Box::new(tls()))))).unwrap();
        assert_eq!(wire["nativeTlsSource"], true);
        assert_eq!(wire.as_object().unwrap().len(), 5);
        // The closed names parsed by the web, in declaration order.
        use IoKindDetail::*;
        let names: Vec<_> = [
            ConnectionRefused,
            ConnectionReset,
            ConnectionAborted,
            HostUnreachable,
            NetworkUnreachable,
            NetworkDown,
            AddrInUse,
            AddrNotAvailable,
            BrokenPipe,
            UnexpectedEof,
            TimedOut,
            NotConnected,
            PermissionDenied,
            InvalidData,
            InvalidInput,
            WouldBlock,
            Interrupted,
            Unsupported,
            OutOfMemory,
            Other,
            Unmapped,
            NotExposed,
        ]
        .into_iter()
        .map(|kind| serde_json::to_value(kind).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "connection_refused",
                "connection_reset",
                "connection_aborted",
                "host_unreachable",
                "network_unreachable",
                "network_down",
                "addr_in_use",
                "addr_not_available",
                "broken_pipe",
                "unexpected_eof",
                "timed_out",
                "not_connected",
                "permission_denied",
                "invalid_data",
                "invalid_input",
                "would_block",
                "interrupted",
                "unsupported",
                "out_of_memory",
                "other",
                "unmapped",
                "not_exposed",
            ]
        );
    }

    fn supplement(error: &(dyn Error + 'static)) -> Option<(UnmappedIoKind, OsFamily, u8)> {
        let detail = send_transport_detail(error);
        let supplement = detail.io_supplement()?;
        assert_eq!(supplement.version, 1);
        // It only ever supplements an unmapped first IO error, at its depth.
        assert_eq!(detail.io_kind_detail, IoKindDetail::Unmapped);
        assert_eq!(walk(error).0, IoKind::Other);
        assert_eq!(walk(error).1, supplement.source_depth);
        assert!((1..=detail.source_depth).contains(&supplement.source_depth));
        Some((
            supplement.io_kind,
            supplement.os_family,
            supplement.source_depth,
        ))
    }

    fn raw(code: i32) -> Option<Box<dyn Error + Send + Sync>> {
        Some(Box::new(std::io::Error::from_raw_os_error(code)))
    }

    /// The family a raw code must get in this build: named only on Windows.
    fn compiled_family(windows: OsFamily) -> OsFamily {
        if cfg!(windows) {
            windows
        } else {
            OsFamily::NotWindows
        }
    }

    #[test]
    fn io_supplement_belongs_only_to_the_first_unmapped_io_error() {
        use std::io::ErrorKind;
        let no_code = compiled_family(OsFamily::NoRawOsCode);
        assert_eq!(
            supplement(&chain(2, io(ErrorKind::NotFound))),
            Some((UnmappedIoKind::NotFound, no_code, 3))
        );
        // A mapped first IO error owns the walk, even above an unmapped one.
        let mapped_above = chain(
            0,
            Some(Box::new(std::io::Error::new(
                ErrorKind::ConnectionReset,
                Link(raw(11001)),
            ))),
        );
        assert_eq!(detail(&mapped_above).0, IoKindDetail::ConnectionReset);
        assert_eq!(supplement(&mapped_above), None);
        // The first unmapped IO error owns it; a deeper code is never read.
        let unmapped_above = chain(
            1,
            Some(Box::new(std::io::Error::new(
                ErrorKind::AlreadyExists,
                Link(raw(11001)),
            ))),
        );
        assert_eq!(detail(&unmapped_above).2, 3);
        assert_eq!(
            supplement(&unmapped_above),
            Some((UnmappedIoKind::AlreadyExists, no_code, 2))
        );
        // No IO error, or a mapped or Other one, has no supplement.
        for error in [
            chain(0, None),
            chain(3, None),
            chain(2, Some(Box::new(tls()))),
            chain(0, io(ErrorKind::Other)),
            chain(0, io(ErrorKind::ConnectionRefused)),
            chain(0, io(ErrorKind::TimedOut)),
        ] {
            assert_eq!(supplement(&error), None);
        }
        // The first and last observed links; a ninth is never inspected.
        assert_eq!(
            supplement(&chain(0, io(ErrorKind::WriteZero))),
            Some((UnmappedIoKind::WriteZero, no_code, 1))
        );
        assert_eq!(
            supplement(&chain(7, io(ErrorKind::WriteZero))),
            Some((UnmappedIoKind::WriteZero, no_code, 8))
        );
        let beyond = chain(8, raw(11001));
        assert_eq!(detail(&beyond), (IoKindDetail::NotExposed, false, 8, true));
        assert_eq!(send_transport_detail(&beyond).io_supplement(), None);
    }

    #[test]
    fn io_supplement_reads_only_the_first_io_errors_own_os_code() {
        for (code, family) in [
            (11001, OsFamily::WinsockHostNotFound),
            (11002, OsFamily::WinsockTryAgain),
            (11003, OsFamily::WinsockNoRecovery),
            (11004, OsFamily::WinsockNoData),
            (11000, OsFamily::OtherWindowsOsCode),
            (11005, OsFamily::OtherWindowsOsCode),
            (-1, OsFamily::OtherWindowsOsCode),
            (i32::MAX, OsFamily::OtherWindowsOsCode),
        ] {
            let (kind, os_family, depth) =
                supplement(&chain(2, raw(code))).unwrap_or_else(|| panic!("{code}"));
            assert_eq!((os_family, depth), (compiled_family(family), 3), "{code}");
            // std leaves these codes uncategorized off Windows.
            if !cfg!(windows) {
                assert_eq!(kind, UnmappedIoKind::Unknown, "{code}");
            }
        }
    }

    #[test]
    fn os_family_names_winsock_codes_only_in_a_windows_build() {
        for (code, windows) in [
            (None, OsFamily::NoRawOsCode),
            (Some(11001), OsFamily::WinsockHostNotFound),
            (Some(11002), OsFamily::WinsockTryAgain),
            (Some(11003), OsFamily::WinsockNoRecovery),
            (Some(11004), OsFamily::WinsockNoData),
            (Some(0), OsFamily::OtherWindowsOsCode),
            (Some(11000), OsFamily::OtherWindowsOsCode),
            (Some(11005), OsFamily::OtherWindowsOsCode),
            (Some(10060), OsFamily::OtherWindowsOsCode),
            (Some(-11001), OsFamily::OtherWindowsOsCode),
            (Some(i32::MIN), OsFamily::OtherWindowsOsCode),
            (Some(i32::MAX), OsFamily::OtherWindowsOsCode),
        ] {
            assert_eq!(OsFamily::classify(code, true), windows, "{code:?}");
            // The same numbers on Linux or macOS are another namespace.
            assert_eq!(
                OsFamily::classify(code, false),
                OsFamily::NotWindows,
                "{code:?}"
            );
        }
    }

    #[test]
    fn io_supplement_splits_only_the_remaining_stable_kinds() {
        use std::io::ErrorKind;
        for (kind, expected) in [
            (ErrorKind::NotFound, UnmappedIoKind::NotFound),
            (ErrorKind::AlreadyExists, UnmappedIoKind::AlreadyExists),
            (ErrorKind::WriteZero, UnmappedIoKind::WriteZero),
            (ErrorKind::NotADirectory, UnmappedIoKind::NotADirectory),
            (ErrorKind::IsADirectory, UnmappedIoKind::IsADirectory),
            (
                ErrorKind::DirectoryNotEmpty,
                UnmappedIoKind::DirectoryNotEmpty,
            ),
            (
                ErrorKind::ReadOnlyFilesystem,
                UnmappedIoKind::ReadOnlyFilesystem,
            ),
            (
                ErrorKind::StaleNetworkFileHandle,
                UnmappedIoKind::StaleNetworkFileHandle,
            ),
            (ErrorKind::StorageFull, UnmappedIoKind::StorageFull),
            (ErrorKind::NotSeekable, UnmappedIoKind::NotSeekable),
            (ErrorKind::QuotaExceeded, UnmappedIoKind::QuotaExceeded),
            (ErrorKind::FileTooLarge, UnmappedIoKind::FileTooLarge),
            (ErrorKind::ResourceBusy, UnmappedIoKind::ResourceBusy),
            (
                ErrorKind::ExecutableFileBusy,
                UnmappedIoKind::ExecutableFileBusy,
            ),
            (ErrorKind::Deadlock, UnmappedIoKind::Deadlock),
            (ErrorKind::CrossesDevices, UnmappedIoKind::CrossesDevices),
            (ErrorKind::TooManyLinks, UnmappedIoKind::TooManyLinks),
            (ErrorKind::InvalidFilename, UnmappedIoKind::InvalidFilename),
            (
                ErrorKind::ArgumentListTooLong,
                UnmappedIoKind::ArgumentListTooLong,
            ),
        ] {
            let no_code = compiled_family(OsFamily::NoRawOsCode);
            assert_eq!(
                supplement(&chain(1, io(kind))),
                Some((expected, no_code, 2)),
                "{kind:?}"
            );
        }
        // Every kind the detail names keeps its name and gets no supplement.
        for kind in [
            ErrorKind::ConnectionRefused,
            ErrorKind::ConnectionReset,
            ErrorKind::ConnectionAborted,
            ErrorKind::HostUnreachable,
            ErrorKind::NetworkUnreachable,
            ErrorKind::NetworkDown,
            ErrorKind::AddrInUse,
            ErrorKind::AddrNotAvailable,
            ErrorKind::BrokenPipe,
            ErrorKind::UnexpectedEof,
            ErrorKind::TimedOut,
            ErrorKind::NotConnected,
            ErrorKind::PermissionDenied,
            ErrorKind::InvalidData,
            ErrorKind::InvalidInput,
            ErrorKind::WouldBlock,
            ErrorKind::Interrupted,
            ErrorKind::Unsupported,
            ErrorKind::OutOfMemory,
            ErrorKind::Other,
        ] {
            assert_eq!(supplement(&chain(1, io(kind))), None, "{kind:?}");
        }
    }

    #[test]
    fn io_supplement_serializes_separately_from_the_frozen_detail() {
        let error = chain(1, raw(11001));
        let detail = send_transport_detail(&error);
        let supplement = detail.io_supplement().expect("an unmapped OS error");
        // The v1 detail's wire shape is unchanged by its cached supplement.
        assert_eq!(
            serde_json::to_value(detail).unwrap(),
            serde_json::json!({
                "version": 1,
                "ioKindDetail": "unmapped",
                "nativeTlsSource": false,
                "sourceDepth": 2,
                "sourceChainTruncated": false,
            })
        );
        let wire = serde_json::to_value(supplement).unwrap();
        let expected_family = if cfg!(windows) {
            "winsock_host_not_found"
        } else {
            "not_windows"
        };
        assert_eq!(wire["version"], 1);
        assert_eq!(wire["osFamily"], expected_family);
        assert_eq!(wire["sourceDepth"], 2);
        assert_eq!(wire.as_object().unwrap().len(), 4);
        assert!(!wire.to_string().contains("11001"));
        assert_eq!(
            serde_json::to_value(SendIoSupplement {
                version: 1,
                io_kind: UnmappedIoKind::NotFound,
                os_family: OsFamily::NoRawOsCode,
                source_depth: 3,
            })
            .unwrap(),
            serde_json::json!({
                "version": 1,
                "ioKind": "not_found",
                "osFamily": "no_raw_os_code",
                "sourceDepth": 3,
            })
        );
        // The closed names parsed by the web, in declaration order.
        use UnmappedIoKind::*;
        let kinds: Vec<_> = [
            NotFound,
            AlreadyExists,
            WriteZero,
            NotADirectory,
            IsADirectory,
            DirectoryNotEmpty,
            ReadOnlyFilesystem,
            StaleNetworkFileHandle,
            StorageFull,
            NotSeekable,
            QuotaExceeded,
            FileTooLarge,
            ResourceBusy,
            ExecutableFileBusy,
            Deadlock,
            CrossesDevices,
            TooManyLinks,
            InvalidFilename,
            ArgumentListTooLong,
            Unknown,
        ]
        .into_iter()
        .map(|kind| serde_json::to_value(kind).unwrap())
        .collect();
        assert_eq!(
            kinds,
            [
                "not_found",
                "already_exists",
                "write_zero",
                "not_a_directory",
                "is_a_directory",
                "directory_not_empty",
                "read_only_filesystem",
                "stale_network_file_handle",
                "storage_full",
                "not_seekable",
                "quota_exceeded",
                "file_too_large",
                "resource_busy",
                "executable_file_busy",
                "deadlock",
                "crosses_devices",
                "too_many_links",
                "invalid_filename",
                "argument_list_too_long",
                "unknown",
            ]
        );
        use OsFamily::*;
        let families: Vec<_> = [
            WinsockHostNotFound,
            WinsockTryAgain,
            WinsockNoRecovery,
            WinsockNoData,
            OtherWindowsOsCode,
            NoRawOsCode,
            NotWindows,
        ]
        .into_iter()
        .map(|family| serde_json::to_value(family).unwrap())
        .collect();
        assert_eq!(
            families,
            [
                "winsock_host_not_found",
                "winsock_try_again",
                "winsock_no_recovery",
                "winsock_no_data",
                "other_windows_os_code",
                "no_raw_os_code",
                "not_windows",
            ]
        );
    }

    /// Fails every lookup with a synthetic stored OS code, without a network.
    struct FailingResolver {
        lookups: Arc<AtomicUsize>,
    }

    impl reqwest::dns::Resolve for FailingResolver {
        fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
            self.lookups.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(Box::new(std::io::Error::from_raw_os_error(11001))
                    as Box<dyn Error + Send + Sync>)
            })
        }
    }

    fn unresolved_request(lookups: &Arc<AtomicUsize>) -> reqwest::RequestBuilder {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .dns_resolver(Arc::new(FailingResolver {
                lookups: lookups.clone(),
            }))
            .build()
            .unwrap()
            .post("https://synthetic.invalid/api/desktop/authorized-operation")
            .json(&serde_json::json!({ "id": "synthetic", "digest": "synthetic" }))
    }

    #[tokio::test]
    async fn unmapped_lookup_failure_supplements_one_send_without_changing_it() {
        let lookups = Arc::new(AtomicUsize::new(0));
        let (receipts, observer) = recorder();
        let error = observed_send(
            unresolved_request(&lookups),
            OriginClass::CanonicalProduction,
            Some(observer),
        )
        .await
        .expect_err("the lookup fails");
        assert!(!error.is_timeout());
        let receipts = receipts.lock().unwrap();
        assert_eq!(receipts.len(), 1);
        let (receipt, cause, detail) = receipts[0];
        let supplement = detail.io_supplement().expect("an unmapped first IO error");
        eprintln!(
            "authorization_lookup_fixture: connect={} request={} io_kind={:?} source_depth={} io_kind_detail={:?} supplement_kind={:?} os_family={:?} supplement_depth={}",
            receipt.connect, receipt.request, cause.io_kind, cause.source_depth,
            detail.io_kind_detail, supplement.io_kind, supplement.os_family,
            supplement.source_depth
        );
        assert_eq!(
            (receipt.timeout, receipt.connect, receipt.request),
            (error.is_timeout(), error.is_connect(), error.is_request())
        );
        // The frozen receipts are exactly those of any unmapped IO error.
        assert_eq!(cause.io_kind, IoKind::Other);
        assert_eq!(detail.io_kind_detail, IoKindDetail::Unmapped);
        assert!(!detail.native_tls_source);
        assert!((1..=MAX_SOURCE_LINKS).contains(&cause.source_depth));
        assert_eq!(supplement.source_depth, cause.source_depth);
        assert_eq!(
            supplement.os_family,
            compiled_family(OsFamily::WinsockHostNotFound)
        );
        if !cfg!(windows) {
            assert_eq!(supplement.io_kind, UnmappedIoKind::Unknown);
        }
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
        drop(receipts);

        // A panicking, closed or absent observer keeps the same single attempt.
        let panicking = observed_send(
            unresolved_request(&lookups),
            OriginClass::CanonicalProduction,
            Some(
                |_: SendFailureReceipt, _: SendFailureCause, detail: SendTransportDetail| {
                    let _ = detail.io_supplement();
                    panic!("observer failure")
                },
            ),
        )
        .await
        .expect_err("panic is contained");
        assert!(panicking.is_connect());
        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);
        let closed = observed_send(
            unresolved_request(&lookups),
            OriginClass::CanonicalProduction,
            Some(move |_, _, detail: SendTransportDetail| {
                let _ = sender.send(detail.io_supplement());
            }),
        )
        .await
        .expect_err("closed callback is ignored");
        assert!(closed.is_connect());
        let direct = observed_send(
            unresolved_request(&lookups),
            OriginClass::CanonicalProduction,
            None::<fn(SendFailureReceipt, SendFailureCause, SendTransportDetail)>,
        )
        .await
        .expect_err("direct path keeps the error");
        assert!(direct.is_connect());
        assert_eq!(lookups.load(Ordering::SeqCst), 4);
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
