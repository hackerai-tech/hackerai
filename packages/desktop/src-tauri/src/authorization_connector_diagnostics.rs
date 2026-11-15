//! Optional connector phase snapshot for the native authorization POST.
//!
//! A pass-through tower layer around reqwest's own connector records only how
//! many times the connector was called and whether the single call's future
//! had resolved when the send failed. `connected` means only that the
//! underlying connector (as reqwest configures DNS, proxy, TCP and TLS)
//! returned a connection: never that the request was written or delivered.
//! DNS, TCP and TLS are not distinguished. Nothing is read from the request
//! URI, the connection or the error, so the snapshot holds no URL, address,
//! hostname, header, body, error text or identifier.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tower_layer::Layer;
use tower_service::Service;

const MAX_ELAPSED_MS: u64 = 60_000;
/// Connector calls are counted up to this bound and saturate there.
const MAX_ATTEMPTS: u8 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorPhase {
    /// The connector was never called.
    NotStarted,
    /// The single call had not resolved. It may have been dropped with the
    /// failed send; it is never reported as finished afterwards.
    Pending,
    /// The single call returned a connection. Not a written or delivered
    /// request.
    Connected,
    /// The single call returned an error.
    Failed,
    /// More than one call; no single phase is claimed.
    Multiple,
}

/// Sent on its own optional channel so the frozen send receipts are unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorPhaseSnapshot {
    version: u8,
    phase: ConnectorPhase,
    /// Connector calls, at most `MAX_ATTEMPTS`.
    attempts: u8,
    /// Monotonic time of the single call: until it resolved, or until the
    /// snapshot while pending. Null when no single call exists.
    elapsed_ms: Option<u64>,
}

fn bounded_elapsed_ms(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_millis())
        .unwrap_or(MAX_ELAPSED_MS)
        .min(MAX_ELAPSED_MS)
}

#[derive(Default)]
struct Attempts {
    count: u8,
    first_started: Option<Instant>,
    /// When the first call resolved, and whether it returned a connection.
    first_settled: Option<(Instant, bool)>,
}

#[derive(Default)]
struct TrackerState {
    attempts: Mutex<Attempts>,
    /// Set once any update could not be recorded; the snapshot is then omitted.
    lost: AtomicBool,
}

/// Never waits on the connector path: a contended or poisoned record is marked
/// lost and its optional snapshot omitted, rather than blocking the connector
/// or reporting a phase it may not have.
#[derive(Clone, Default)]
struct ConnectorPhaseTracker(Arc<TrackerState>);

impl ConnectorPhaseTracker {
    fn try_with_attempts<T>(&self, f: impl FnOnce(&mut Attempts) -> T) -> Option<T> {
        match self.0.attempts.try_lock() {
            Ok(mut attempts) => Some(f(&mut attempts)),
            Err(_) => {
                self.0.lost.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    /// Counts a call; returns whether it is the first one.
    fn start(&self) -> bool {
        self.try_with_attempts(|attempts| {
            let first = attempts.count == 0;
            attempts.count = attempts.count.saturating_add(1).min(MAX_ATTEMPTS);
            if first {
                attempts.first_started = Some(Instant::now());
            }
            first
        })
        .unwrap_or(false)
    }

    fn settle_first(&self, connected: bool) {
        self.try_with_attempts(|attempts| {
            attempts
                .first_settled
                .get_or_insert((Instant::now(), connected));
        });
    }

    /// A copied value: a call that resolves later cannot change it. `None`
    /// when any update was lost.
    fn snapshot(&self) -> Option<ConnectorPhaseSnapshot> {
        let snapshot = self.try_with_attempts(|attempts| {
            let (phase, elapsed_ms) = match (attempts.count, attempts.first_started) {
                (1, Some(started)) => match attempts.first_settled {
                    None => (ConnectorPhase::Pending, Some(started.elapsed())),
                    Some((settled, connected)) => (
                        if connected {
                            ConnectorPhase::Connected
                        } else {
                            ConnectorPhase::Failed
                        },
                        Some(settled.saturating_duration_since(started)),
                    ),
                },
                (0, _) => (ConnectorPhase::NotStarted, None),
                _ => (ConnectorPhase::Multiple, None),
            };
            ConnectorPhaseSnapshot {
                version: 1,
                phase,
                attempts: attempts.count,
                elapsed_ms: elapsed_ms.map(bounded_elapsed_ms),
            }
        });
        // Read after the attempt: a failed snapshot also marks the record lost.
        snapshot.filter(|_| !self.0.lost.load(Ordering::SeqCst))
    }
}

#[derive(Clone)]
struct ConnectorPhaseLayer(ConnectorPhaseTracker);

impl<S> Layer<S> for ConnectorPhaseLayer {
    type Service = ConnectorPhaseService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ConnectorPhaseService {
            inner,
            tracker: self.0.clone(),
        }
    }
}

#[derive(Clone)]
struct ConnectorPhaseService<S> {
    inner: S,
    tracker: ConnectorPhaseTracker,
}

impl<S, Request> Service<Request> for ConnectorPhaseService<S>
where
    S: Service<Request>,
    S::Future: Unpin,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = ConnectorPhaseFuture<S::Future>;

    /// Readiness belongs to the same inner service that is then called.
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let first = self.tracker.start();
        ConnectorPhaseFuture {
            inner: self.inner.call(request),
            first: first.then(|| self.tracker.clone()),
        }
    }
}

/// Owns the inner future, so dropping this cancels it; its output is returned
/// unchanged.
struct ConnectorPhaseFuture<F> {
    inner: F,
    first: Option<ConnectorPhaseTracker>,
}

impl<F, T, E> Future for ConnectorPhaseFuture<F>
where
    F: Future<Output = Result<T, E>> + Unpin,
{
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let output = std::task::ready!(Pin::new(&mut self.inner).poll(cx));
        if let Some(tracker) = self.first.take() {
            tracker.settle_first(output.is_ok());
        }
        Poll::Ready(output)
    }
}

/// Present only when the frontend supplied the connector channel.
pub struct ConnectorPhaseReport<H> {
    tracker: ConnectorPhaseTracker,
    observer: H,
}

/// Without an observer, returns `builder` untouched: reqwest keeps its
/// unlayered connector. With one, wraps the existing connector in the
/// pass-through layer; reqwest still builds the connector, resolver, proxies
/// and TLS itself.
pub fn observe_connector<H>(
    builder: reqwest::ClientBuilder,
    observer: Option<H>,
) -> (reqwest::ClientBuilder, Option<ConnectorPhaseReport<H>>)
where
    H: FnOnce(ConnectorPhaseSnapshot),
{
    let Some(observer) = observer else {
        return (builder, None);
    };
    let tracker = ConnectorPhaseTracker::default();
    let builder = builder.connector_layer(ConnectorPhaseLayer(tracker.clone()));
    (builder, Some(ConnectorPhaseReport { tracker, observer }))
}

/// Joins the snapshot to the send-failure observer, so it is taken only at the
/// original send failure, never for an answered POST. The snapshot is taken
/// before either observer runs, and the existing observer is called first.
/// A lost record omits only the snapshot. Without either observer this is
/// `None`, keeping the direct send.
pub fn with_connector_phase<F, H, A, B, C>(
    send_failure_observer: Option<F>,
    report: Option<ConnectorPhaseReport<H>>,
) -> Option<impl FnOnce(A, B, C)>
where
    F: FnOnce(A, B, C),
    H: FnOnce(ConnectorPhaseSnapshot),
{
    if send_failure_observer.is_none() && report.is_none() {
        return None;
    }
    Some(move |receipt: A, cause: B, detail: C| {
        let snapshot = report.map(|report| (report.tracker.snapshot(), report.observer));
        if let Some(observer) = send_failure_observer {
            observer(receipt, cause, detail);
        }
        if let Some((Some(snapshot), observer)) = snapshot {
            observer(snapshot);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorization_send_diagnostics::{
        observed_send, OriginClass, SendFailureCause, SendFailureReceipt, SendTransportDetail,
    };
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::task::Waker;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A connector stand-in with scripted readiness. It is not `Clone`, and it
    /// rejects a call on an instance that did not just report readiness.
    struct Scripted {
        readiness: VecDeque<Poll<Result<(), &'static str>>>,
        ready: bool,
    }

    impl Scripted {
        fn new(readiness: impl IntoIterator<Item = Poll<Result<(), &'static str>>>) -> Self {
            Self {
                readiness: readiness.into_iter().collect(),
                ready: false,
            }
        }
    }

    impl Service<()> for Scripted {
        type Response = u8;
        type Error = &'static str;
        type Future = Outcome;

        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            let next = self.readiness.pop_front().unwrap_or(Poll::Ready(Ok(())));
            self.ready = matches!(next, Poll::Ready(Ok(())));
            next
        }

        fn call(&mut self, _: ()) -> Outcome {
            assert!(std::mem::take(&mut self.ready), "call without readiness");
            Outcome::default()
        }
    }

    /// Resolves only with the exact output the test supplies.
    #[derive(Default)]
    struct Outcome {
        output: Arc<Mutex<Option<Result<u8, &'static str>>>>,
        dropped: Arc<AtomicBool>,
    }

    impl Future for Outcome {
        type Output = Result<u8, &'static str>;

        fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
            match self.output.lock().unwrap().take() {
                Some(output) => Poll::Ready(output),
                None => Poll::Pending,
            }
        }
    }

    impl Drop for Outcome {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    fn poll_once<F: Future + Unpin>(future: &mut F) -> Poll<F::Output> {
        Pin::new(future).poll(&mut Context::from_waker(Waker::noop()))
    }

    fn ready<S: Service<()>>(service: &mut S) -> Poll<Result<(), S::Error>> {
        service.poll_ready(&mut Context::from_waker(Waker::noop()))
    }

    fn layered(tracker: &ConnectorPhaseTracker) -> ConnectorPhaseService<Scripted> {
        ConnectorPhaseLayer(tracker.clone()).layer(Scripted::new([]))
    }

    fn connect(service: &mut ConnectorPhaseService<Scripted>) -> ConnectorPhaseFuture<Outcome> {
        assert_eq!(ready(service), Poll::Ready(Ok(())));
        service.call(())
    }

    fn snap(tracker: &ConnectorPhaseTracker) -> ConnectorPhaseSnapshot {
        tracker.snapshot().expect("every update was recorded")
    }

    /// Holds the record's lock on another thread until released, or for at
    /// most a few seconds, so a blocking implementation fails instead of hangs.
    struct Holder {
        release: std::sync::mpsc::Sender<()>,
        released: Arc<AtomicBool>,
        thread: std::thread::JoinHandle<()>,
    }

    impl Holder {
        fn hold(tracker: &ConnectorPhaseTracker) -> Self {
            let (release, wait) = std::sync::mpsc::channel();
            let (held, holding) = std::sync::mpsc::channel();
            let released = Arc::new(AtomicBool::new(false));
            let (state, flag) = (tracker.0.clone(), released.clone());
            let thread = std::thread::spawn(move || {
                let guard = state.attempts.lock().unwrap();
                held.send(()).unwrap();
                let _ = wait.recv_timeout(Duration::from_secs(5));
                flag.store(true, Ordering::SeqCst);
                drop(guard);
            });
            holding.recv().unwrap();
            Self {
                release,
                released,
                thread,
            }
        }

        fn released(&self) -> bool {
            self.released.load(Ordering::SeqCst)
        }

        fn release(self) {
            let _ = self.release.send(());
            self.thread.join().unwrap();
        }
    }

    /// Composes the native observers and reports which ones ran.
    fn report_failure(tracker: &ConnectorPhaseTracker) -> (usize, Vec<ConnectorPhaseSnapshot>) {
        let sent = Arc::new(AtomicUsize::new(0));
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let (counted, delivered) = (sent.clone(), snapshots.clone());
        let report = ConnectorPhaseReport {
            tracker: tracker.clone(),
            observer: move |snapshot: ConnectorPhaseSnapshot| {
                delivered.lock().unwrap().push(snapshot);
            },
        };
        let observer = with_connector_phase(
            Some(move |_: u8, _: u8, _: u8| {
                counted.fetch_add(1, Ordering::SeqCst);
            }),
            Some(report),
        )
        .unwrap();
        observer(0, 0, 0);
        let snapshots = snapshots.lock().unwrap().clone();
        (sent.load(Ordering::SeqCst), snapshots)
    }

    #[test]
    fn authorization_connector_held_record_never_blocks_and_omits_only_the_snapshot() {
        // Held while the call starts: the call is not counted.
        let tracker = ConnectorPhaseTracker::default();
        let mut service = layered(&tracker);
        assert_eq!(ready(&mut service), Poll::Ready(Ok(())));
        let holder = Holder::hold(&tracker);
        let mut connecting = service.call(());
        *connecting.inner.output.lock().unwrap() = Some(Ok(7));
        assert_eq!(poll_once(&mut connecting), Poll::Ready(Ok(7)));
        assert!(tracker.snapshot().is_none());
        assert!(!holder.released(), "the connector path waited for the lock");
        holder.release();
        // Still omitted once free: a missed call would make any phase false.
        assert!(tracker.snapshot().is_none());
        assert_eq!(report_failure(&tracker), (1, Vec::new()));

        // Held only while the call resolves: the exact error is still returned.
        let tracker = ConnectorPhaseTracker::default();
        let mut connecting = connect(&mut layered(&tracker));
        let holder = Holder::hold(&tracker);
        *connecting.inner.output.lock().unwrap() = Some(Err("refused"));
        assert_eq!(poll_once(&mut connecting), Poll::Ready(Err("refused")));
        assert!(!holder.released(), "the connector path waited for the lock");
        holder.release();
        assert_eq!(report_failure(&tracker), (1, Vec::new()));

        // Held only at the failure: the existing observer still runs at once.
        let tracker = ConnectorPhaseTracker::default();
        let _connecting = connect(&mut layered(&tracker));
        let holder = Holder::hold(&tracker);
        assert_eq!(report_failure(&tracker), (1, Vec::new()));
        assert!(
            !holder.released(),
            "the failure observer waited for the lock"
        );
        holder.release();
    }

    #[test]
    fn authorization_connector_poisoned_record_omits_only_the_snapshot() {
        let tracker = ConnectorPhaseTracker::default();
        let mut service = layered(&tracker);
        let state = tracker.0.clone();
        let poisoned = std::thread::spawn(move || {
            let _guard = state.attempts.lock().unwrap();
            panic!("synthetic poison");
        })
        .join();
        assert!(poisoned.is_err());
        let mut connecting = connect(&mut service);
        *connecting.inner.output.lock().unwrap() = Some(Err("refused"));
        assert_eq!(poll_once(&mut connecting), Poll::Ready(Err("refused")));
        assert!(tracker.snapshot().is_none());
        assert_eq!(report_failure(&tracker), (1, Vec::new()));
    }

    #[test]
    fn authorization_connector_layer_passes_readiness_and_exact_output_through() {
        let tracker = ConnectorPhaseTracker::default();
        let mut service = ConnectorPhaseLayer(tracker.clone())
            .layer(Scripted::new([Poll::Pending, Poll::Ready(Err("busy"))]));
        assert_eq!(ready(&mut service), Poll::Pending);
        assert_eq!(ready(&mut service), Poll::Ready(Err("busy")));
        // Readiness alone is not a connector call.
        assert_eq!(snap(&tracker).phase, ConnectorPhase::NotStarted);
        assert_eq!(snap(&tracker).attempts, 0);
        let mut connecting = connect(&mut service);
        assert_eq!(snap(&tracker).phase, ConnectorPhase::Pending);
        assert_eq!(poll_once(&mut connecting), Poll::Pending);
        *connecting.inner.output.lock().unwrap() = Some(Ok(7));
        assert_eq!(poll_once(&mut connecting), Poll::Ready(Ok(7)));
        let snapshot = snap(&tracker);
        assert_eq!(
            (snapshot.phase, snapshot.attempts),
            (ConnectorPhase::Connected, 1)
        );
        assert!(snapshot.elapsed_ms.is_some());

        let tracker = ConnectorPhaseTracker::default();
        let mut connecting = connect(&mut layered(&tracker));
        *connecting.inner.output.lock().unwrap() = Some(Err("refused"));
        assert_eq!(poll_once(&mut connecting), Poll::Ready(Err("refused")));
        let snapshot = snap(&tracker);
        assert_eq!(
            (snapshot.phase, snapshot.attempts),
            (ConnectorPhase::Failed, 1)
        );
    }

    #[test]
    fn authorization_connector_cancellation_drops_the_call_and_stays_pending() {
        let tracker = ConnectorPhaseTracker::default();
        let mut connecting = connect(&mut layered(&tracker));
        let dropped = connecting.inner.dropped.clone();
        assert_eq!(poll_once(&mut connecting), Poll::Pending);
        let before = snap(&tracker);
        drop(connecting);
        assert!(dropped.load(Ordering::SeqCst));
        // A cancelled call never resolved: it is not reported as connected or
        // failed, and its time keeps growing monotonically.
        let after = snap(&tracker);
        assert_eq!((after.phase, after.attempts), (ConnectorPhase::Pending, 1));
        assert!(after.elapsed_ms.unwrap() >= before.elapsed_ms.unwrap());
    }

    #[test]
    fn authorization_connector_multiple_calls_are_ambiguous_and_bounded() {
        let tracker = ConnectorPhaseTracker::default();
        let mut service = layered(&tracker);
        let mut first = connect(&mut service);
        *first.inner.output.lock().unwrap() = Some(Ok(1));
        assert_eq!(poll_once(&mut first), Poll::Ready(Ok(1)));
        let mut calls = Vec::new();
        for count in 2..=20u8 {
            calls.push(connect(&mut service));
            let snapshot = snap(&tracker);
            // The first call's connection is not claimed for the whole send.
            assert_eq!(snapshot.phase, ConnectorPhase::Multiple);
            assert_eq!(snapshot.attempts, count.min(MAX_ATTEMPTS));
            assert_eq!(snapshot.elapsed_ms, None);
        }
        // Later calls resolving changes nothing either.
        for call in &mut calls {
            *call.inner.output.lock().unwrap() = Some(Ok(2));
            assert_eq!(poll_once(call), Poll::Ready(Ok(2)));
        }
        assert_eq!(snap(&tracker).phase, ConnectorPhase::Multiple);
        assert_eq!(snap(&tracker).attempts, MAX_ATTEMPTS);
    }

    #[test]
    fn authorization_connector_snapshot_is_fixed_at_the_send_failure() {
        let tracker = ConnectorPhaseTracker::default();
        let mut connecting = connect(&mut layered(&tracker));
        let order = Arc::new(Mutex::new(Vec::new()));
        let (sent, delivered) = (order.clone(), order.clone());
        let report = ConnectorPhaseReport {
            tracker: tracker.clone(),
            observer: move |snapshot: ConnectorPhaseSnapshot| {
                delivered.lock().unwrap().push(Err(snapshot));
            },
        };
        let observer = with_connector_phase(
            Some(move |receipt: u8, _: (), _: ()| sent.lock().unwrap().push(Ok(receipt))),
            Some(report),
        )
        .expect("an observer is present");
        observer(9, (), ());
        // The call resolves after the failure was reported.
        *connecting.inner.output.lock().unwrap() = Some(Ok(1));
        assert_eq!(poll_once(&mut connecting), Poll::Ready(Ok(1)));
        assert_eq!(snap(&tracker).phase, ConnectorPhase::Connected);
        let order = order.lock().unwrap();
        // The existing observer runs first; the snapshot stays pending.
        assert_eq!(order.len(), 2);
        assert_eq!(order[0], Ok(9));
        let Err(snapshot) = order[1] else {
            panic!("the connector snapshot is delivered second")
        };
        assert_eq!(
            (snapshot.phase, snapshot.attempts),
            (ConnectorPhase::Pending, 1)
        );
    }

    #[test]
    fn authorization_connector_absent_observer_keeps_the_direct_path() {
        type Snapshots = fn(ConnectorPhaseSnapshot);
        let (_, report) = observe_connector(reqwest::Client::builder(), None::<Snapshots>);
        assert!(report.is_none());
        assert!(with_connector_phase(None::<fn(u8, u8, u8)>, report).is_none());
        // The existing observer alone is still composed, unchanged.
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let observer = with_connector_phase(
            Some(move |_: u8, _: u8, _: u8| {
                counted.fetch_add(1, Ordering::SeqCst);
            }),
            None::<ConnectorPhaseReport<Snapshots>>,
        )
        .unwrap();
        observer(0, 0, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn authorization_connector_snapshot_serializes_only_its_closed_schema() {
        let wire = serde_json::to_value(snap(&ConnectorPhaseTracker::default())).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "version": 1,
                "phase": "not_started",
                "attempts": 0,
                "elapsedMs": null,
            })
        );
        // A call older than the bound is reported at the bound.
        let tracker = ConnectorPhaseTracker::default();
        let _pending = connect(&mut layered(&tracker));
        if let Some(old) = Instant::now().checked_sub(Duration::from_secs(120)) {
            tracker
                .try_with_attempts(|attempts| attempts.first_started = Some(old))
                .unwrap();
            let wire = serde_json::to_value(snap(&tracker)).unwrap();
            assert_eq!(wire["phase"], "pending");
            assert_eq!(wire["elapsedMs"], MAX_ELAPSED_MS);
        }
        use ConnectorPhase::*;
        let names: Vec<_> = [NotStarted, Pending, Connected, Failed, Multiple]
            .into_iter()
            .map(|phase| serde_json::to_value(phase).unwrap())
            .collect();
        assert_eq!(
            names,
            ["not_started", "pending", "connected", "failed", "multiple"]
        );
    }

    /// Accepts connections and counts each POST head. `answer` replies 200;
    /// otherwise the request is read and never answered.
    async fn http_url(answer: bool) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/api/desktop/authorized-operation",
            listener.local_addr().unwrap()
        );
        let posts = Arc::new(AtomicUsize::new(0));
        let counted = posts.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let counted = counted.clone();
                tokio::spawn(async move {
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
                    if answer {
                        let response =
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}";
                        let _ = socket.write_all(response).await;
                    } else {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                });
            }
        });
        (url, posts)
    }

    /// An `https` endpoint that accepts TCP and never answers the client's TLS
    /// handshake, so the connector itself stalls. Counts connections.
    async fn stalled_tls_url() -> (String, Arc<AtomicUsize>) {
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
                    while let Ok(n) = socket.read(&mut buffer).await {
                        if n == 0 {
                            break;
                        }
                    }
                });
            }
        });
        (url, connections)
    }

    async fn refused_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}/api/desktop/authorized-operation")
    }

    /// What the frozen send observer saw, in its public wire form.
    type SendReport = (serde_json::Value, SendFailureCause, SendTransportDetail);

    struct Sent {
        result: reqwest::Result<reqwest::Response>,
        receipts: Vec<SendReport>,
        snapshots: Vec<ConnectorPhaseSnapshot>,
    }

    /// One send through the native composition, with or without the
    /// connector channel. Only proxies differ from the native client.
    async fn send(url: &str, timeout: Duration, observe_phase: bool) -> Sent {
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let delivered = snapshots.clone();
        let phase_observer = observe_phase.then(|| {
            move |snapshot: ConnectorPhaseSnapshot| delivered.lock().unwrap().push(snapshot)
        });
        let builder = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy();
        let (builder, report) = observe_connector(builder, phase_observer);
        let request = builder
            .build()
            .unwrap()
            .post(url)
            .json(&serde_json::json!({ "id": "synthetic", "digest": "synthetic" }));
        let receipts = Arc::new(Mutex::new(Vec::new()));
        let recorded = receipts.clone();
        let send_observer = Some(
            move |receipt: SendFailureReceipt,
                  cause: SendFailureCause,
                  detail: SendTransportDetail| {
                let receipt = serde_json::to_value(receipt).unwrap();
                recorded.lock().unwrap().push((receipt, cause, detail));
            },
        );
        let result = observed_send(
            request,
            OriginClass::Localhost,
            with_connector_phase(send_observer, report),
        )
        .await;
        let receipts = receipts.lock().unwrap().clone();
        let snapshots = snapshots.lock().unwrap().clone();
        Sent {
            result,
            receipts,
            snapshots,
        }
    }

    /// The layered send keeps the unlayered send's result and frozen receipts.
    fn assert_same_failure(layered: &Sent, direct: &Sent) {
        let (layered_error, direct_error) = (
            layered.result.as_ref().expect_err("layered send fails"),
            direct.result.as_ref().expect_err("direct send fails"),
        );
        assert_eq!(
            (
                layered_error.is_timeout(),
                layered_error.is_connect(),
                layered_error.is_request()
            ),
            (
                direct_error.is_timeout(),
                direct_error.is_connect(),
                direct_error.is_request()
            )
        );
        assert_eq!(layered.receipts.len(), 1);
        assert_eq!(direct.receipts.len(), 1);
        let (
            (layered_receipt, layered_cause, layered_detail),
            (direct_receipt, direct_cause, direct_detail),
        ) = (&layered.receipts[0], &direct.receipts[0]);
        for key in [
            "version",
            "timeout",
            "connect",
            "request",
            "originClass",
            "platform",
        ] {
            assert_eq!(layered_receipt[key], direct_receipt[key], "{key}");
        }
        assert_eq!(layered_cause, direct_cause);
        assert_eq!(layered_detail, direct_detail);
        assert!(direct.snapshots.is_empty());
    }

    fn single(sent: &Sent) -> ConnectorPhaseSnapshot {
        assert_eq!(sent.snapshots.len(), 1);
        let snapshot = sent.snapshots[0];
        assert_eq!((snapshot.version, snapshot.attempts), (1, 1));
        snapshot
    }

    fn send_elapsed_ms(sent: &Sent) -> u64 {
        sent.receipts[0].0["elapsedMs"].as_u64().unwrap()
    }

    #[tokio::test]
    async fn authorization_connector_lost_response_is_connected_after_one_post() {
        let (url, posts) = http_url(false).await;
        let timeout = Duration::from_millis(250);
        let direct = send(&url, timeout, false).await;
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        let layered = send(&url, timeout, true).await;
        assert!(layered.result.as_ref().unwrap_err().is_timeout());
        assert_same_failure(&layered, &direct);
        // The connector returned its connection; the request then went
        // unanswered until reqwest's own unchanged deadline.
        let snapshot = single(&layered);
        assert_eq!(snapshot.phase, ConnectorPhase::Connected);
        let send_elapsed = send_elapsed_ms(&layered);
        assert!((200..=5_000).contains(&send_elapsed), "{send_elapsed}");
        assert!(snapshot.elapsed_ms.unwrap() <= send_elapsed);
        // Give an unexpected retry time to arrive before counting.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn authorization_connector_stalled_tls_handshake_is_pending() {
        let (url, connections) = stalled_tls_url().await;
        let timeout = Duration::from_millis(300);
        let direct = send(&url, timeout, false).await;
        let layered = send(&url, timeout, true).await;
        assert!(layered.result.as_ref().unwrap_err().is_timeout());
        assert_same_failure(&layered, &direct);
        let snapshot = single(&layered);
        assert_eq!(snapshot.phase, ConnectorPhase::Pending);
        // Measured at the failure: the call was still in the connector.
        let elapsed = snapshot.elapsed_ms.unwrap();
        assert!((200..=5_000).contains(&elapsed), "{elapsed}");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(connections.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn authorization_connector_refusal_is_failed() {
        let url = refused_url().await;
        // The native budget: a refusal must not be preempted by the deadline.
        let timeout = Duration::from_secs(8);
        let direct = send(&url, timeout, false).await;
        let layered = send(&url, timeout, true).await;
        assert!(layered.result.as_ref().unwrap_err().is_connect());
        assert_same_failure(&layered, &direct);
        let snapshot = single(&layered);
        assert_eq!(snapshot.phase, ConnectorPhase::Failed);
        assert!(snapshot.elapsed_ms.unwrap() <= send_elapsed_ms(&layered));
        let wire = serde_json::to_value(snapshot).unwrap().to_string();
        assert!(!wire.contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn authorization_connector_answered_post_reports_nothing() {
        let (url, posts) = http_url(true).await;
        let sent = send(&url, Duration::from_secs(2), true).await;
        let response = sent.result.expect("an answered POST is not a send failure");
        assert_eq!(response.status().as_u16(), 200);
        assert!(sent.receipts.is_empty());
        assert!(sent.snapshots.is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 1);
    }
}
