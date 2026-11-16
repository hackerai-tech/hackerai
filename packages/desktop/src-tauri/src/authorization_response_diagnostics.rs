//! The native authorization response's approval check, with an optional
//! receipt when that check rejects an answered POST.
//!
//! Kept independent of Tauri so it can be exercised with an actual reqwest
//! client against loopback fixtures. The receipt holds only the HTTP status, a
//! closed approval class, the fixed origin class, the compiled target platform
//! and the shape of the response's `x-vercel-id` header. That header's value is
//! copied only when it matches a strict observed subset of Vercel's public,
//! non-authorizing request ID; this is not a guarantee of the provider format.
//! The receipt never holds the body, other headers, URLs, authorization IDs,
//! digests or error text.
//!
//! A separate mitigation receipt, frozen apart from that v1 shape, holds only a
//! closed class of the same response's `x-vercel-mitigated` header. The value
//! is compared against exact literals and never copied; a matching literal is
//! an observed marker, not an authenticated provider decision.
//!
//! A separate read snapshot, only for its own observer, holds a closed kind of
//! the existing JSON read's error and the extent of one bounded typed walk of
//! that error's sources. The kind needs positive typed evidence; it never
//! formats the error or holds its text, the body, a position or a type name.

use std::error::Error;
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::authorization_send_diagnostics::{OriginClass, MAX_SOURCE_LINKS};

/// The original fixed public errors, unchanged.
const NOT_AUTHORIZED: &str = "Desktop operation was not authorized";
const INVALID_RESPONSE: &str = "Invalid Desktop authorization response";

const REQUEST_ID_HEADER: &str = "x-vercel-id";
const MAX_REQUEST_ID_LEN: usize = 96;
const MAX_REQUEST_ID_REGIONS: usize = 3;
const MITIGATION_HEADER: &str = "x-vercel-mitigated";

/// Why an answered POST was not approved. An approved response has no class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    /// A non-2xx status; the body was never read.
    NotChecked,
    /// A 2xx body could not be read or decoded as JSON. Either cause is
    /// possible; this is not a claim that the body was malformed JSON.
    JsonError,
    ApprovedFalse,
    /// No `approved` member, including a JSON value that is not an object.
    Missing,
    /// An `approved` member that is not a boolean.
    InvalidType,
}

/// The same closed class as the send receipt's platform.
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
#[serde(rename_all = "snake_case")]
pub enum RequestIdShape {
    Absent,
    /// One value within the strict subset; only this shape carries the value.
    Valid,
    /// One readable value outside the strict subset.
    Unrecognized,
    /// No single readable value: repeated headers or non-visible-ASCII bytes.
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseRejectionReceipt {
    version: u8,
    http_status: u16,
    approval: Approval,
    origin_class: OriginClass,
    platform: Platform,
    request_id_shape: RequestIdShape,
    /// Null unless `request_id_shape` is valid.
    request_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mitigation {
    Absent,
    Challenge,
    Deny,
    RateLimit,
    /// One visible-ASCII value that is not exactly one of the literals.
    Other,
    /// No single readable value: repeated headers or bytes outside visible
    /// ASCII, including spaces.
    Unreadable,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMitigationReceipt {
    version: u8,
    mitigation: Mitigation,
}

/// Why the existing JSON read of a 2xx body failed, from typed evidence only.
/// A class of the reported error, not the customer's physical cause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseReadKind {
    /// reqwest's public `is_timeout` on the original error.
    Timeout,
    /// A nested `reqwest::Error` whose `is_body` is true: body collection
    /// failed. The outer error's `is_decode` covers both stages and is unused.
    BodyRead,
    SerdeEof,
    SerdeSyntax,
    SerdeData,
    SerdeIo,
    /// No typed witness within the walked links, which is not a cause.
    Unclassified,
}

/// Sent on its own optional channel so the response receipts' shapes are
/// frozen. `source_depth` counts the walked sources, excluding the error
/// itself; it is neither the witness's nor the physical depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseReadSnapshot {
    version: u8,
    kind: ResponseReadKind,
    source_depth: u8,
    /// Another link existed beyond the last one walked.
    source_chain_truncated: bool,
}

fn serde_kind(error: &serde_json::Error) -> ResponseReadKind {
    use serde_json::error::Category;
    match error.classify() {
        Category::Eof => ResponseReadKind::SerdeEof,
        Category::Syntax => ResponseReadKind::SerdeSyntax,
        Category::Data => ResponseReadKind::SerdeData,
        Category::Io => ResponseReadKind::SerdeIo,
    }
}

/// Walks at most `MAX_SOURCE_LINKS` sources of `error` (not `error` itself),
/// keeping the nearest typed witness: a `serde_json::Error`'s category or a
/// nested reqwest body error. Only `source`, `downcast_ref`, `classify` and
/// `is_body` are called: never `Display`, `Debug` or any other accessor. A
/// `timeout` comes first, but like any kind it needs at least one walked link.
fn read_snapshot(error: &(dyn Error + 'static), timeout: bool) -> ResponseReadSnapshot {
    let mut witness = None;
    let mut source_depth = 0;
    let mut source_chain_truncated = false;
    let mut source = error.source();
    while let Some(link) = source {
        if source_depth == MAX_SOURCE_LINKS {
            source_chain_truncated = true;
            break;
        }
        source_depth += 1;
        if witness.is_none() {
            if let Some(parser) = link.downcast_ref::<serde_json::Error>() {
                witness = Some(serde_kind(parser));
            } else if link
                .downcast_ref::<reqwest::Error>()
                .is_some_and(reqwest::Error::is_body)
            {
                witness = Some(ResponseReadKind::BodyRead);
            }
        }
        source = link.source();
    }
    let kind = match (source_depth, timeout, witness) {
        (0, _, _) => ResponseReadKind::Unclassified,
        (_, true, _) => ResponseReadKind::Timeout,
        (_, false, witness) => witness.unwrap_or(ResponseReadKind::Unclassified),
    };
    ResponseReadSnapshot {
        version: 1,
        kind,
        source_depth,
        source_chain_truncated,
    }
}

/// Only for the original error of the existing JSON read. reqwest's public
/// `is_timeout` walks reqwest's own sources separately from, and is not
/// bounded by, `read_snapshot`'s walk.
fn json_read_snapshot(error: &reqwest::Error) -> ResponseReadSnapshot {
    read_snapshot(error, error.is_timeout())
}

fn read_mitigation(headers: &reqwest::header::HeaderMap) -> Mitigation {
    let mut values = headers.get_all(MITIGATION_HEADER).iter();
    let Some(value) = values.next() else {
        return Mitigation::Absent;
    };
    if values.next().is_some() {
        return Mitigation::Unreadable;
    }
    let bytes = value.as_bytes();
    if !bytes.iter().all(u8::is_ascii_graphic) {
        return Mitigation::Unreadable;
    }
    match bytes {
        b"challenge" => Mitigation::Challenge,
        b"deny" => Mitigation::Deny,
        b"rate_limit" => Mitigation::RateLimit,
        _ => Mitigation::Other,
    }
}

fn is_region(region: &[u8]) -> bool {
    matches!(region, [a, b, c, digit]
        if [a, b, c].iter().all(|letter| letter.is_ascii_lowercase())
            && (b'1'..=b'9').contains(digit))
}

fn is_request_tail(tail: &[u8]) -> bool {
    tail.len() == 32
        && tail[..5]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && tail[5] == b'-'
        && tail[6..19].iter().all(u8::is_ascii_digit)
        && tail[19] == b'-'
        && tail[20..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

/// One to three `abc1::` region prefixes, then `[a-z0-9]{5}-\d{13}-[0-9a-f]{12}`,
/// at most 96 bytes in total. Anything else, including surrounding whitespace,
/// a query or a list, is not copied.
fn is_strict_request_id(value: &[u8]) -> bool {
    if value.len() > MAX_REQUEST_ID_LEN {
        return false;
    }
    let mut rest = value;
    let mut regions = 0;
    while let Some(separator) = rest.windows(2).position(|pair| pair == b"::") {
        regions += 1;
        if regions > MAX_REQUEST_ID_REGIONS || !is_region(&rest[..separator]) {
            return false;
        }
        rest = &rest[separator + 2..];
    }
    regions >= 1 && is_request_tail(rest)
}

fn read_request_id(headers: &reqwest::header::HeaderMap) -> (RequestIdShape, Option<String>) {
    let mut values = headers.get_all(REQUEST_ID_HEADER).iter();
    let Some(value) = values.next() else {
        return (RequestIdShape::Absent, None);
    };
    if values.next().is_some() {
        return (RequestIdShape::Unreadable, None);
    }
    let Ok(text) = value.to_str() else {
        return (RequestIdShape::Unreadable, None);
    };
    if is_strict_request_id(text.as_bytes()) {
        (RequestIdShape::Valid, Some(text.to_owned()))
    } else {
        (RequestIdShape::Unrecognized, None)
    }
}

/// Applies the original approval check to `response`, with its original
/// result. A non-2xx response's body is never read.
///
/// Only a rejection is reported, once, with both receipts, before its error is
/// returned; an approved response has none. Only a failed JSON read is
/// reported to `read_observer`, once, after them; its error is inspected only
/// when that observer exists, and only while borrowed. Neither observer can
/// retry, delay beyond its own call or change the result. Panic containment
/// applies to unwinding builds only; release builds abort, so production
/// observers must not panic (they ignore channel send failures).
pub async fn observed_approval<F, G>(
    response: reqwest::Response,
    origin_class: OriginClass,
    observer: Option<F>,
    read_observer: Option<G>,
) -> Result<(), String>
where
    F: FnOnce(ResponseRejectionReceipt, ResponseMitigationReceipt),
    G: FnOnce(ResponseReadSnapshot),
{
    let status = response.status();
    // Read before the body consumes the response, and only for an observer.
    let headers = observer.as_ref().map(|_| {
        (
            read_request_id(response.headers()),
            read_mitigation(response.headers()),
        )
    });
    let mut read = None;
    let (approval, error) = if !status.is_success() {
        (Approval::NotChecked, NOT_AUTHORIZED)
    } else {
        match response.json::<serde_json::Value>().await {
            Err(read_error) => {
                if read_observer.is_some() {
                    read = Some(json_read_snapshot(&read_error));
                }
                (Approval::JsonError, INVALID_RESPONSE)
            }
            Ok(body) => match body.get("approved") {
                Some(serde_json::Value::Bool(true)) => return Ok(()),
                Some(serde_json::Value::Bool(false)) => (Approval::ApprovedFalse, NOT_AUTHORIZED),
                None => (Approval::Missing, NOT_AUTHORIZED),
                Some(_) => (Approval::InvalidType, NOT_AUTHORIZED),
            },
        }
    };
    let http_status = status.as_u16();
    if let (Some(observer), Some(((request_id_shape, request_id), mitigation))) =
        (observer, headers)
    {
        // The receipt's status class is closed; an extension status sends none.
        if (100..=599).contains(&http_status) {
            let receipt = ResponseRejectionReceipt {
                version: 1,
                http_status,
                approval,
                origin_class,
                platform: Platform::from_target_os(std::env::consts::OS),
                request_id_shape,
                request_id,
            };
            let mitigation = ResponseMitigationReceipt {
                version: 1,
                mitigation,
            };
            let _ = catch_unwind(AssertUnwindSafe(|| observer(receipt, mitigation)));
        }
    }
    if let (Some(read_observer), Some(snapshot)) = (read_observer, read) {
        let _ = catch_unwind(AssertUnwindSafe(|| read_observer(snapshot)));
    }
    Err(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const VALID_ID: &str = "iad1::abcde-1700000000000-0123456789ab";
    const PRIVATE: &str = "PRIVATE-CANARY";

    /// A synthetic loopback endpoint that answers every request with `response`
    /// (raw HTTP bytes) and counts POST requests. With `hold`, the connection
    /// stays open afterwards, so an attempt to read a declared but unsent body
    /// waits for the client deadline.
    async fn serve(response: Vec<u8>, hold: bool) -> (String, Arc<AtomicUsize>) {
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
                let _ = socket.write_all(&response).await;
                if hold {
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        drop(socket);
                    });
                }
            }
        });
        (url, posts)
    }

    fn http(status: &str, headers: &[&str], body: &str) -> Vec<u8> {
        let mut response = format!("HTTP/1.1 {status}\r\nconnection: close\r\n");
        for header in headers {
            response.push_str(header);
            response.push_str("\r\n");
        }
        response.push_str(&format!("content-length: {}\r\n\r\n{body}", body.len()));
        response.into_bytes()
    }

    fn json(status: &str, headers: &[&str], body: &str) -> Vec<u8> {
        let mut headers = headers.to_vec();
        headers.push("content-type: application/json");
        http(status, &headers, body)
    }

    /// The native request's client: one POST, no redirects, the 8s budget.
    async fn answered(url: &str) -> reqwest::Response {
        answered_within(url, Duration::from_secs(8)).await
    }

    /// The same client with a shorter total budget, only so a held body's
    /// timeout is observed quickly; production keeps 8s.
    async fn answered_within(url: &str, budget: Duration) -> reqwest::Response {
        reqwest::Client::builder()
            .timeout(budget)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap()
            .post(url)
            .json(&serde_json::json!({ "id": "synthetic", "digest": "synthetic" }))
            .send()
            .await
            .expect("the fixture answers")
    }

    type Observation = (ResponseRejectionReceipt, ResponseMitigationReceipt);
    type Recorded = Arc<Mutex<Vec<Observation>>>;

    fn recorder() -> (
        Recorded,
        impl FnOnce(ResponseRejectionReceipt, ResponseMitigationReceipt),
    ) {
        let receipts = Arc::new(Mutex::new(Vec::new()));
        let recorded = receipts.clone();
        (receipts, move |receipt, mitigation| {
            recorded.lock().unwrap().push((receipt, mitigation))
        })
    }

    const NO_READ: Option<fn(ResponseReadSnapshot)> = None;

    /// Runs the check once with both recorders, bounded well below the
    /// client's 8s budget so a body read on a held connection fails the test.
    async fn check_read(
        response: Vec<u8>,
        hold: bool,
        budget: Duration,
    ) -> (
        Result<(), String>,
        Vec<Observation>,
        Vec<ResponseReadSnapshot>,
        usize,
    ) {
        let (url, posts) = serve(response, hold).await;
        let (receipts, observer) = recorder();
        let reads = Arc::new(Mutex::new(Vec::new()));
        let recorded = reads.clone();
        let read_observer =
            move |snapshot: ResponseReadSnapshot| recorded.lock().unwrap().push(snapshot);
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            observed_approval(
                answered_within(&url, budget).await,
                OriginClass::Localhost,
                Some(observer),
                Some(read_observer),
            )
            .await
        })
        .await
        .expect("the approval check never waits for an unread body");
        // Give an unexpected retry or redirect time to arrive before counting.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let receipts = receipts.lock().unwrap().clone();
        let reads = reads.lock().unwrap().clone();
        (result, receipts, reads, posts.load(Ordering::SeqCst))
    }

    /// Every case also requests a read snapshot: only a failed JSON read, and
    /// never an approval, unread non-2xx or decoded rejection, reports one.
    async fn check_observed(
        response: Vec<u8>,
        hold: bool,
    ) -> (Result<(), String>, Vec<Observation>, usize) {
        let (result, receipts, reads, posts) =
            check_read(response, hold, Duration::from_secs(8)).await;
        let json_errors = receipts
            .iter()
            .filter(|(receipt, _)| receipt.approval == Approval::JsonError)
            .count();
        assert_eq!(reads.len(), json_errors, "{receipts:?}");
        (result, receipts, posts)
    }

    async fn check(
        response: Vec<u8>,
        hold: bool,
    ) -> (Result<(), String>, Vec<ResponseRejectionReceipt>, usize) {
        let (result, observed, posts) = check_observed(response, hold).await;
        let receipts = observed.into_iter().map(|(receipt, _)| receipt).collect();
        (result, receipts, posts)
    }

    #[tokio::test]
    async fn approval_succeeds_unchanged_without_a_receipt() {
        let (result, receipts, posts) = check_observed(
            json(
                "200 OK",
                &[
                    &format!("x-vercel-id: {VALID_ID}"),
                    "x-vercel-mitigated: challenge",
                ],
                r#"{"approved":true,"extra":1}"#,
            ),
            false,
        )
        .await;
        assert_eq!(result, Ok(()));
        assert!(receipts.is_empty());
        assert_eq!(posts, 1);
    }

    #[tokio::test]
    async fn non_success_statuses_are_rejected_without_reading_the_body() {
        for status in [
            "401 Unauthorized",
            "403 Forbidden",
            "500 Internal Server Error",
            "503 Service Unavailable",
        ] {
            // A declared body that is never sent: reading it would wait for the
            // client deadline. Its content would otherwise have been approved.
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nx-vercel-id: {VALID_ID}\r\ncontent-length: 4096\r\n\r\n{{\"approved\":true,\"{PRIVATE}\":1"
            );
            let (result, receipts, posts) = check(response.into_bytes(), true).await;
            assert_eq!(result, Err(NOT_AUTHORIZED.to_string()));
            assert_eq!(posts, 1);
            assert_eq!(receipts.len(), 1);
            let receipt = &receipts[0];
            assert_eq!(receipt.approval, Approval::NotChecked);
            assert_eq!(
                receipt.http_status.to_string(),
                status.split(' ').next().unwrap()
            );
            assert_eq!(receipt.request_id_shape, RequestIdShape::Valid);
            assert_eq!(receipt.request_id.as_deref(), Some(VALID_ID));
            assert!(!serde_json::to_string(receipt).unwrap().contains(PRIVATE));
        }
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed_or_parsed() {
        let (result, receipts, posts) = check(
            json(
                "307 Temporary Redirect",
                &["location: /api/desktop/authorized-operation?approved=true"],
                r#"{"approved":true}"#,
            ),
            false,
        )
        .await;
        assert_eq!(result, Err(NOT_AUTHORIZED.to_string()));
        assert_eq!(posts, 1);
        assert_eq!(receipts.len(), 1);
        assert_eq!(
            (receipts[0].http_status, receipts[0].approval),
            (307, Approval::NotChecked)
        );
        assert_eq!(receipts[0].request_id_shape, RequestIdShape::Absent);
        assert_eq!(receipts[0].request_id, None);
    }

    /// A 200 whose declared body is only partly sent before the server closes
    /// (`hold` false) or keeps the connection open (`hold` true).
    fn truncated_ok() -> Vec<u8> {
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 4096\r\n\r\n{{\"approved\":true,\"{PRIVATE}\":1").into_bytes()
    }

    #[tokio::test]
    async fn unreadable_or_undecodable_success_bodies_keep_the_original_error() {
        // A truncated body is a read failure, not malformed JSON; both share
        // the one closed approval class and the original error, and only the
        // separate read snapshot tells them apart from typed evidence.
        let eight = Duration::from_secs(8);
        for (response, hold, budget, kind) in [
            // Complete HTTP bodies the parser rejects.
            (
                json("200 OK", &[], r#"{"approved":true"#),
                false,
                eight,
                ResponseReadKind::SerdeEof,
            ),
            (
                json("200 OK", &[], ""),
                false,
                eight,
                ResponseReadKind::SerdeEof,
            ),
            (
                json("200 OK", &[], &format!("not json {PRIVATE}")),
                false,
                eight,
                ResponseReadKind::SerdeSyntax,
            ),
            (
                http("200 OK", &["content-type: text/html"], "<html>"),
                false,
                eight,
                ResponseReadKind::SerdeSyntax,
            ),
            // The same incomplete JSON, but the HTTP body itself ends early.
            (truncated_ok(), false, eight, ResponseReadKind::BodyRead),
            // A held body reaches the client's total deadline.
            (
                truncated_ok(),
                true,
                Duration::from_millis(300),
                ResponseReadKind::Timeout,
            ),
        ] {
            let (result, observed, reads, posts) = check_read(response, hold, budget).await;
            println!("observed read snapshot: {reads:?}");
            assert_eq!(result, Err(INVALID_RESPONSE.to_string()), "{kind:?}");
            assert_eq!(posts, 1, "{kind:?}");
            assert_eq!(observed.len(), 1, "{kind:?}");
            let receipt = &observed[0].0;
            assert_eq!(
                (receipt.http_status, receipt.approval),
                (200, Approval::JsonError)
            );
            assert_eq!(reads.len(), 1, "{kind:?}");
            let read = reads[0];
            assert_eq!(read.kind, kind);
            assert!(
                (1..=MAX_SOURCE_LINKS).contains(&read.source_depth),
                "{read:?}"
            );
            assert!(!read.source_chain_truncated, "{read:?}");
            if matches!(
                kind,
                ResponseReadKind::SerdeEof | ResponseReadKind::SerdeSyntax
            ) {
                // reqwest's decode error directly wraps the parser's error.
                assert_eq!(read.source_depth, 1);
            }
            for serialized in [
                serde_json::to_string(receipt).unwrap(),
                serde_json::to_string(&read).unwrap(),
            ] {
                assert!(!serialized.contains(PRIVATE));
                assert!(!serialized.contains("127.0.0.1"));
                assert!(!serialized.contains("synthetic"));
            }

            // A fresh request afterwards is approved normally, with no snapshot.
            let (result, observed, reads, posts) =
                check_read(json("200 OK", &[], r#"{"approved":true}"#), false, eight).await;
            assert_eq!(result, Ok(()));
            assert!(observed.is_empty() && reads.is_empty());
            assert_eq!(posts, 1);
        }
    }

    #[tokio::test]
    async fn the_read_snapshot_serializes_only_its_closed_schema() {
        let (_, _, reads, _) = check_read(
            json("200 OK", &[], &format!(r#"{{"{PRIVATE}":"#)),
            false,
            Duration::from_secs(8),
        )
        .await;
        assert_eq!(
            serde_json::to_value(reads[0]).unwrap(),
            serde_json::json!({
                "version": 1,
                "kind": "serde_eof",
                "sourceDepth": 1,
                "sourceChainTruncated": false,
            })
        );
        for (kind, wire) in [
            (ResponseReadKind::Timeout, "timeout"),
            (ResponseReadKind::BodyRead, "body_read"),
            (ResponseReadKind::SerdeEof, "serde_eof"),
            (ResponseReadKind::SerdeSyntax, "serde_syntax"),
            (ResponseReadKind::SerdeData, "serde_data"),
            (ResponseReadKind::SerdeIo, "serde_io"),
            (ResponseReadKind::Unclassified, "unclassified"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), wire);
        }
    }

    /// An opaque link whose formatting fails the test: the walk only ever
    /// borrows sources and downcasts them.
    struct Opaque(Option<Box<dyn Error>>);

    impl std::fmt::Display for Opaque {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("an error was formatted")
        }
    }

    impl std::fmt::Debug for Opaque {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("an error was formatted")
        }
    }

    impl Error for Opaque {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.0.as_deref()
        }
    }

    /// A root whose sources are `links` opaque links, then `tail`.
    fn wrapped(links: usize, tail: Option<Box<dyn Error>>) -> Opaque {
        let mut next = tail;
        for _ in 0..links {
            next = Some(Box::new(Opaque(next)));
        }
        Opaque(next)
    }

    /// Every link is its own source; it is also never formatted.
    struct Cycle;

    impl std::fmt::Display for Cycle {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("an error was formatted")
        }
    }

    impl std::fmt::Debug for Cycle {
        fn fmt(&self, _: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            panic!("an error was formatted")
        }
    }

    impl Error for Cycle {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(self)
        }
    }

    struct FailingReader;

    impl std::io::Read for FailingReader {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::ConnectionReset.into())
        }
    }

    fn snapshot(kind: ResponseReadKind, depth: u8, truncated: bool) -> ResponseReadSnapshot {
        ResponseReadSnapshot {
            version: 1,
            kind,
            source_depth: depth,
            source_chain_truncated: truncated,
        }
    }

    fn parser_error(category: serde_json::error::Category) -> Box<dyn Error> {
        use serde_json::error::Category;
        let error = match category {
            Category::Eof => serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err(),
            Category::Syntax => serde_json::from_slice::<serde_json::Value>(b"x").unwrap_err(),
            Category::Data => serde_json::from_slice::<bool>(b"1").unwrap_err(),
            Category::Io => {
                serde_json::from_reader::<_, serde_json::Value>(FailingReader).unwrap_err()
            }
        };
        assert_eq!(error.classify(), category);
        Box::new(error)
    }

    /// The bounded typed walk alone, on synthetic chains. reqwest's unbounded
    /// `is_timeout` is never called on them; `timeout` is supplied directly.
    /// Data and IO parser categories are classified here only as typed
    /// errors; they are not claimed as outcomes of the native `Value` read.
    #[test]
    fn the_typed_walk_is_bounded_and_needs_positive_evidence() {
        use serde_json::error::Category;
        use ResponseReadKind::*;
        for (category, kind) in [
            (Category::Eof, SerdeEof),
            (Category::Syntax, SerdeSyntax),
            (Category::Data, SerdeData),
            (Category::Io, SerdeIo),
        ] {
            let chain = wrapped(0, Some(parser_error(category)));
            assert_eq!(read_snapshot(&chain, false), snapshot(kind, 1, false));
            // The nearest witness at the last walked link is still classified.
            let chain = wrapped(7, Some(parser_error(category)));
            assert_eq!(read_snapshot(&chain, false), snapshot(kind, 8, false));
            // One link further, it is beyond the budget and never guessed.
            let chain = wrapped(8, Some(parser_error(category)));
            assert_eq!(
                read_snapshot(&chain, false),
                snapshot(Unclassified, 8, true)
            );
            // A timeout comes first, whatever the walk witnessed.
            let chain = wrapped(2, Some(parser_error(category)));
            assert_eq!(read_snapshot(&chain, true), snapshot(Timeout, 3, false));
        }
        // No witness is not a body failure, however deep the chain.
        assert_eq!(
            read_snapshot(&wrapped(0, None), false),
            snapshot(Unclassified, 0, false)
        );
        assert_eq!(
            read_snapshot(&wrapped(3, None), false),
            snapshot(Unclassified, 3, false)
        );
        assert_eq!(
            read_snapshot(&wrapped(8, None), false),
            snapshot(Unclassified, 8, false)
        );
        assert_eq!(
            read_snapshot(&wrapped(9, None), false),
            snapshot(Unclassified, 8, true)
        );
        // A positive kind needs a walked link, even with a timeout.
        assert_eq!(
            read_snapshot(&wrapped(0, None), true),
            snapshot(Unclassified, 0, false)
        );
        // A cycle ends at the budget.
        assert_eq!(
            read_snapshot(&Cycle, false),
            snapshot(Unclassified, 8, true)
        );
        assert_eq!(read_snapshot(&Cycle, true), snapshot(Timeout, 8, true));
        let cyclic_tail = wrapped(3, Some(Box::new(Cycle)));
        assert_eq!(
            read_snapshot(&cyclic_tail, false),
            snapshot(Unclassified, 8, true)
        );
        // The exact closed wire of a truncated walk.
        assert_eq!(
            serde_json::to_value(read_snapshot(&Cycle, false)).unwrap(),
            serde_json::json!({
                "version": 1,
                "kind": "unclassified",
                "sourceDepth": 8,
                "sourceChainTruncated": true,
            })
        );
    }

    /// The original error of a direct JSON read of an actual loopback response.
    async fn json_read_error(response: Vec<u8>, hold: bool, budget: Duration) -> reqwest::Error {
        let (url, _) = serve(response, hold).await;
        answered_within(&url, budget)
            .await
            .json::<serde_json::Value>()
            .await
            .unwrap_err()
    }

    #[tokio::test]
    async fn actual_reqwest_witnesses_are_found_behind_opaque_wrappers() {
        let eight = Duration::from_secs(8);
        // The outer decode predicate covers both stages, so it is unused.
        let body = json_read_error(truncated_ok(), false, eight).await;
        let parser = json_read_error(json("200 OK", &[], "{"), false, eight).await;
        assert!(body.is_decode() && parser.is_decode());
        assert!(!body.is_timeout() && !parser.is_timeout());
        let body_depth = json_read_snapshot(&body).source_depth;
        // Behind two opaque links, a nested body error is the nearest witness
        // even though deeper transport links follow it.
        let chain = wrapped(2, Some(Box::new(body)));
        let behind = read_snapshot(&chain, false);
        assert_eq!(behind.kind, ResponseReadKind::BodyRead);
        assert_eq!(
            behind.source_depth,
            (body_depth + 3).min(MAX_SOURCE_LINKS),
            "{behind:?}"
        );
        let chain = wrapped(1, Some(Box::new(parser)));
        assert_eq!(
            read_snapshot(&chain, false),
            snapshot(ResponseReadKind::SerdeEof, 3, false)
        );
        // A held body's genuine timeout error also carries a nested body
        // witness: only reqwest's trusted predicate puts the timeout first.
        let held = json_read_error(truncated_ok(), true, Duration::from_millis(300)).await;
        assert!(held.is_timeout());
        assert_eq!(json_read_snapshot(&held).kind, ResponseReadKind::Timeout);
        assert_eq!(read_snapshot(&held, false).kind, ResponseReadKind::BodyRead);
    }

    #[tokio::test]
    async fn decoded_bodies_without_approval_are_classified() {
        for (body, approval) in [
            (r#"{"approved":false}"#, Approval::ApprovedFalse),
            (r#"{}"#, Approval::Missing),
            (r#"{"Approved":true}"#, Approval::Missing),
            (r#"[{"approved":true}]"#, Approval::Missing),
            (r#"true"#, Approval::Missing),
            (r#"{"approved":"true"}"#, Approval::InvalidType),
            (r#"{"approved":1}"#, Approval::InvalidType),
            (r#"{"approved":null}"#, Approval::InvalidType),
            (r#"{"approved":{"value":true}}"#, Approval::InvalidType),
        ] {
            let (result, receipts, posts) = check(json("201 Created", &[], body), false).await;
            assert_eq!(result, Err(NOT_AUTHORIZED.to_string()), "{body}");
            assert_eq!(posts, 1);
            assert_eq!(receipts.len(), 1);
            assert_eq!(
                (receipts[0].http_status, receipts[0].approval),
                (201, approval),
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn the_receipts_serialize_only_their_closed_schemas() {
        let (_, observed, _) = check_observed(
            json(
                "403 Forbidden",
                &[
                    &format!("x-vercel-id: {VALID_ID}"),
                    "x-vercel-mitigated: deny",
                    &format!("x-request-id: {PRIVATE}"),
                    &format!("set-cookie: session={PRIVATE}"),
                ],
                &format!(r#"{{"error":"{PRIVATE}"}}"#),
            ),
            false,
        )
        .await;
        // The frozen v1 receipt is unchanged by the mitigation header.
        let wire = serde_json::to_value(&observed[0].0).unwrap();
        let expected_platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "unknown"
        };
        assert_eq!(
            wire,
            serde_json::json!({
                "version": 1,
                "httpStatus": 403,
                "approval": "not_checked",
                "originClass": "localhost",
                "platform": expected_platform,
                "requestIdShape": "valid",
                "requestId": VALID_ID,
            })
        );
        let mitigation = serde_json::to_value(&observed[0].1).unwrap();
        assert_eq!(
            mitigation,
            serde_json::json!({ "version": 1, "mitigation": "deny" })
        );
        for serialized in [wire.to_string(), mitigation.to_string()] {
            assert!(!serialized.contains(PRIVATE));
            assert!(!serialized.contains("127.0.0.1"));
            assert!(!serialized.contains("synthetic"));
        }
    }

    /// A rejected 403 whose declared body is never sent: reading it would
    /// wait for the client deadline, and it would otherwise have approved.
    fn held_forbidden(headers: &[&str]) -> Vec<u8> {
        let mut response =
            "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n".to_string();
        for header in headers {
            response.push_str(header);
            response.push_str("\r\n");
        }
        response.push_str(&format!(
            "content-length: 4096\r\n\r\n{{\"approved\":true,\"{PRIVATE}\":1"
        ));
        response.into_bytes()
    }

    #[tokio::test]
    async fn only_exact_mitigation_literals_are_classified() {
        let huge = "challenge".repeat(1024);
        // Values of one `x-vercel-mitigated` header each, unless noted.
        let cases: Vec<(Vec<&str>, Mitigation)> = vec![
            (vec![], Mitigation::Absent),
            (vec!["challenge"], Mitigation::Challenge),
            (vec!["deny"], Mitigation::Deny),
            (vec!["rate_limit"], Mitigation::RateLimit),
            (vec!["Challenge"], Mitigation::Other),
            (vec!["DENY"], Mitigation::Other),
            (vec!["rate-limit"], Mitigation::Other),
            (vec!["challenge,deny"], Mitigation::Other),
            (vec!["deny;reason=x"], Mitigation::Other),
            (vec!["\"deny\""], Mitigation::Other),
            (vec![PRIVATE], Mitigation::Other),
            (vec![&huge], Mitigation::Other),
            // Internal spaces and tabs are not visible ASCII.
            (vec!["rate limit"], Mitigation::Unreadable),
            (vec!["de\tny"], Mitigation::Unreadable),
            (vec!["deny", "deny"], Mitigation::Unreadable),
            (vec!["challenge", "deny"], Mitigation::Unreadable),
        ];
        for (values, expected) in cases {
            let headers: Vec<String> = values
                .iter()
                .map(|value| format!("x-vercel-mitigated: {value}"))
                .collect();
            let headers: Vec<&str> = headers.iter().map(String::as_str).collect();
            let (result, observed, posts) = check_observed(held_forbidden(&headers), true).await;
            assert_eq!(result, Err(NOT_AUTHORIZED.to_string()), "{values:?}");
            assert_eq!(posts, 1, "{values:?}");
            assert_eq!(observed.len(), 1, "{values:?}");
            let (receipt, mitigation) = &observed[0];
            assert_eq!(
                (receipt.http_status, receipt.approval),
                (403, Approval::NotChecked),
                "{values:?}"
            );
            assert_eq!(
                *mitigation,
                ResponseMitigationReceipt {
                    version: 1,
                    mitigation: expected
                },
                "{values:?}"
            );
            let wire = serde_json::to_string(mitigation).unwrap();
            assert!(!wire.contains(PRIVATE), "{values:?}");
            assert!(wire.len() < 48, "{values:?}");
        }

        // Bytes outside visible ASCII, including obs-text and invalid UTF-8.
        let mut obs_text =
            b"HTTP/1.1 403 Forbidden\r\nconnection: close\r\nx-vercel-mitigated: den".to_vec();
        obs_text.extend_from_slice(&[0xff, 0xfe]);
        obs_text.extend_from_slice(b"\r\ncontent-length: 0\r\n\r\n");
        let mut non_ascii = b"HTTP/1.1 403 Forbidden\r\nconnection: close\r\n".to_vec();
        non_ascii.extend_from_slice("x-vercel-mitigated: dény\r\n".as_bytes());
        non_ascii.extend_from_slice(b"content-length: 0\r\n\r\n");
        for response in [obs_text, non_ascii] {
            let (result, observed, posts) = check_observed(response, false).await;
            assert_eq!(result, Err(NOT_AUTHORIZED.to_string()));
            assert_eq!(posts, 1);
            assert_eq!(observed[0].1.mitigation, Mitigation::Unreadable);
        }

        // A 2xx rejection carries the same response's marker.
        let (result, observed, posts) = check_observed(
            json(
                "200 OK",
                &["x-vercel-mitigated: rate_limit"],
                r#"{"approved":false}"#,
            ),
            false,
        )
        .await;
        assert_eq!(result, Err(NOT_AUTHORIZED.to_string()));
        assert_eq!(posts, 1);
        assert_eq!(observed[0].0.approval, Approval::ApprovedFalse);
        assert_eq!(observed[0].1.mitigation, Mitigation::RateLimit);
    }

    #[tokio::test]
    async fn only_a_single_strict_request_id_is_copied() {
        let huge = format!("x-vercel-id: {}", "a".repeat(8 * 1024));
        let private = format!("x-vercel-id: iad1::{PRIVATE}");
        let query = format!("x-vercel-id: {VALID_ID}?token={PRIVATE}");
        let first = format!("x-vercel-id: {VALID_ID}");
        let second = "x-vercel-id: sfo1::abcde-1700000000000-0123456789ab".to_string();
        // A CRLF ends the header line: the injected header is never copied.
        let crlf = format!("x-vercel-id: {VALID_ID}\r\nx-private: {PRIVATE}");
        let cases: Vec<(Vec<&str>, RequestIdShape, Option<&str>)> = vec![
            (vec![], RequestIdShape::Absent, None),
            (vec![&crlf], RequestIdShape::Valid, Some(VALID_ID)),
            (vec![&private], RequestIdShape::Unrecognized, None),
            (vec![&query], RequestIdShape::Unrecognized, None),
            (vec![&huge], RequestIdShape::Unrecognized, None),
            (vec![&first, &second], RequestIdShape::Unreadable, None),
            (vec![&first, &first], RequestIdShape::Unreadable, None),
        ];
        for (headers, shape, id) in cases {
            let (_, receipts, _) = check(json("403 Forbidden", &headers, "{}"), false).await;
            assert_eq!(receipts[0].request_id_shape, shape, "{headers:?}");
            assert_eq!(receipts[0].request_id.as_deref(), id, "{headers:?}");
            assert!(!serde_json::to_string(&receipts[0])
                .unwrap()
                .contains(PRIVATE));
        }
        // Bytes outside visible ASCII, including obs-text and invalid UTF-8.
        let mut obs_text =
            b"HTTP/1.1 403 Forbidden\r\nconnection: close\r\nx-vercel-id: iad1::".to_vec();
        obs_text.extend_from_slice(&[0xff, 0xfe]);
        obs_text.extend_from_slice(b"\r\ncontent-length: 0\r\n\r\n");
        let (_, receipts, _) = check(obs_text, false).await;
        assert_eq!(receipts[0].request_id_shape, RequestIdShape::Unreadable);
        assert_eq!(receipts[0].request_id, None);
    }

    #[tokio::test]
    async fn observer_failures_and_absence_keep_the_original_result() {
        let forbidden = || json("403 Forbidden", &[], "{}");
        let (url, posts) = serve(forbidden(), false).await;
        let panicking = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            Some(
                |_: ResponseRejectionReceipt, _: ResponseMitigationReceipt| {
                    panic!("observer failure")
                },
            ),
            NO_READ,
        )
        .await;
        assert_eq!(panicking, Err(NOT_AUTHORIZED.to_string()));

        // Each closed channel fails on its own, as at the IPC boundary.
        let (sender, receiver) = std::sync::mpsc::channel();
        let (mitigation_sender, mitigation_receiver) = std::sync::mpsc::channel();
        drop(receiver);
        drop(mitigation_receiver);
        let closed = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            Some(move |receipt, mitigation| {
                let _ = sender.send(receipt);
                let _ = mitigation_sender.send(mitigation);
            }),
            NO_READ,
        )
        .await;
        assert_eq!(closed, Err(NOT_AUTHORIZED.to_string()));

        let direct = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            None::<fn(ResponseRejectionReceipt, ResponseMitigationReceipt)>,
            NO_READ,
        )
        .await;
        assert_eq!(direct, Err(NOT_AUTHORIZED.to_string()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 3);

        // Without observers, every class keeps its original result.
        for (response, expected) in [
            (json("200 OK", &[], r#"{"approved":true}"#), Ok(())),
            (json("200 OK", &[], "{"), Err(INVALID_RESPONSE.to_string())),
            (
                json("200 OK", &[], r#"{"approved":false}"#),
                Err(NOT_AUTHORIZED.to_string()),
            ),
        ] {
            let (url, _) = serve(response, false).await;
            let result = observed_approval(
                answered(&url).await,
                OriginClass::Localhost,
                None::<fn(ResponseRejectionReceipt, ResponseMitigationReceipt)>,
                NO_READ,
            )
            .await;
            assert_eq!(result, expected);
        }

        // A failing read observer, alone or beside the response observer,
        // keeps the original JSON error and its single POST.
        let (url, posts) = serve(json("200 OK", &[], "{"), false).await;
        let (receipts, observer) = recorder();
        let panicking_read = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            Some(observer),
            Some(|_: ResponseReadSnapshot| panic!("read observer failure")),
        )
        .await;
        assert_eq!(panicking_read, Err(INVALID_RESPONSE.to_string()));
        assert_eq!(receipts.lock().unwrap()[0].0.approval, Approval::JsonError);
        let (read_sender, read_receiver) = std::sync::mpsc::channel();
        drop(read_receiver);
        let closed_read = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            None::<fn(ResponseRejectionReceipt, ResponseMitigationReceipt)>,
            Some(move |snapshot| {
                let _ = read_sender.send(snapshot);
            }),
        )
        .await;
        assert_eq!(closed_read, Err(INVALID_RESPONSE.to_string()));
        // The read observer alone still receives its snapshot.
        let (read_sender, read_receiver) = std::sync::mpsc::channel();
        let read_only = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            None::<fn(ResponseRejectionReceipt, ResponseMitigationReceipt)>,
            Some(move |snapshot| {
                let _ = read_sender.send(snapshot);
            }),
        )
        .await;
        assert_eq!(read_only, Err(INVALID_RESPONSE.to_string()));
        assert_eq!(
            read_receiver.try_iter().collect::<Vec<_>>(),
            vec![snapshot(ResponseReadKind::SerdeEof, 1, false)]
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn strict_request_id_accepts_only_the_observed_subset() {
        for valid in [
            VALID_ID,
            "iad9::00000-0000000000000-000000000000",
            "cle1::iad1::zzzzz-9999999999999-ffffffffffff",
            "cle1::iad1::sfo1::a1b2c-1700000000000-abcdef012345",
        ] {
            assert!(is_strict_request_id(valid.as_bytes()), "{valid}");
        }
        let tail = "abcde-1700000000000-0123456789ab";
        for invalid in [
            "".to_string(),
            tail.to_string(),
            format!("::{tail}"),
            format!("cle1::iad1::sfo1::dub1::{tail}"),
            format!("iad0::{tail}"),
            format!("IAD1::{tail}"),
            format!("ia1::{tail}"),
            format!("iadd1::{tail}"),
            format!("iad12::{tail}"),
            format!("iad1:::{tail}"),
            format!("iad1:{tail}"),
            format!("iad1::{tail}::"),
            "iad1::abcd-1700000000000-0123456789ab".to_string(),
            "iad1::abcdef-1700000000000-0123456789ab".to_string(),
            "iad1::ABCDE-1700000000000-0123456789ab".to_string(),
            "iad1::abc_e-1700000000000-0123456789ab".to_string(),
            "iad1::abcde-170000000000-0123456789ab".to_string(),
            "iad1::abcde-17000000000000-0123456789ab".to_string(),
            "iad1::abcde-17000000000a0-0123456789ab".to_string(),
            "iad1::abcde-1700000000000-0123456789a".to_string(),
            "iad1::abcde-1700000000000-0123456789abc".to_string(),
            "iad1::abcde-1700000000000-0123456789AB".to_string(),
            "iad1::abcde-1700000000000-0123456789ag".to_string(),
            "iad1::abcde_1700000000000-0123456789ab".to_string(),
            format!(" {VALID_ID}"),
            format!("{VALID_ID} "),
            format!("{VALID_ID}\r\n"),
            format!("{VALID_ID}\r\nx-private: {PRIVATE}"),
            format!("{VALID_ID}?token={PRIVATE}"),
            format!("{VALID_ID},{VALID_ID}"),
            format!("{VALID_ID}::{VALID_ID}"),
            format!("iad1::{PRIVATE}"),
            "iad1::".repeat(16) + tail,
            "a".repeat(MAX_REQUEST_ID_LEN + 1),
            "iad1::".repeat(100_000) + tail,
        ] {
            assert!(!is_strict_request_id(invalid.as_bytes()), "{invalid:?}");
        }
        // Non-ASCII digits and letters are outside the ASCII classes.
        assert!(!is_strict_request_id(
            "iad1::abcdé-1700000000000-0123456789a".as_bytes()
        ));
        assert!(!is_strict_request_id(
            "iad1::abcde-١٧٠٠٠٠٠٠٠٠٠٠٠-0123456789ab".as_bytes()
        ));
    }

    #[test]
    fn platform_is_a_closed_class_of_the_target_os() {
        for (os, platform) in [
            ("macos", Platform::Darwin),
            ("linux", Platform::Linux),
            ("windows", Platform::Windows),
            ("darwin", Platform::Unknown),
            ("ios", Platform::Unknown),
            ("", Platform::Unknown),
        ] {
            assert_eq!(Platform::from_target_os(os), platform, "{os}");
        }
    }
}
