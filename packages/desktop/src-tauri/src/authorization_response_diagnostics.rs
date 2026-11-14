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

use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::authorization_send_diagnostics::OriginClass;

/// The original fixed public errors, unchanged.
const NOT_AUTHORIZED: &str = "Desktop operation was not authorized";
const INVALID_RESPONSE: &str = "Invalid Desktop authorization response";

const REQUEST_ID_HEADER: &str = "x-vercel-id";
const MAX_REQUEST_ID_LEN: usize = 96;
const MAX_REQUEST_ID_REGIONS: usize = 3;

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
/// Only a rejection is reported, once, before its error is returned; an
/// approved response has no receipt. The observer cannot retry, delay beyond
/// its own call or change the result. Panic containment applies to unwinding
/// builds only; release builds abort, so the production observer must not
/// panic (it ignores channel send failures).
pub async fn observed_approval<F>(
    response: reqwest::Response,
    origin_class: OriginClass,
    observer: Option<F>,
) -> Result<(), String>
where
    F: FnOnce(ResponseRejectionReceipt),
{
    let status = response.status();
    // Read before the body consumes the response, and only for an observer.
    let request_id = observer
        .as_ref()
        .map(|_| read_request_id(response.headers()));
    let (approval, error) = if !status.is_success() {
        (Approval::NotChecked, NOT_AUTHORIZED)
    } else {
        match response.json::<serde_json::Value>().await {
            Err(_) => (Approval::JsonError, INVALID_RESPONSE),
            Ok(body) => match body.get("approved") {
                Some(serde_json::Value::Bool(true)) => return Ok(()),
                Some(serde_json::Value::Bool(false)) => (Approval::ApprovedFalse, NOT_AUTHORIZED),
                None => (Approval::Missing, NOT_AUTHORIZED),
                Some(_) => (Approval::InvalidType, NOT_AUTHORIZED),
            },
        }
    };
    let http_status = status.as_u16();
    if let (Some(observer), Some((request_id_shape, request_id))) = (observer, request_id) {
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
            let _ = catch_unwind(AssertUnwindSafe(|| observer(receipt)));
        }
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
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
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

    type Recorded = Arc<Mutex<Vec<ResponseRejectionReceipt>>>;

    fn recorder() -> (Recorded, impl FnOnce(ResponseRejectionReceipt)) {
        let receipts = Arc::new(Mutex::new(Vec::new()));
        let recorded = receipts.clone();
        (receipts, move |receipt| {
            recorded.lock().unwrap().push(receipt)
        })
    }

    /// Runs the check once with a recorder, bounded well below the client's
    /// 8s budget so a body read on a held connection fails the test.
    async fn check(
        response: Vec<u8>,
        hold: bool,
    ) -> (Result<(), String>, Vec<ResponseRejectionReceipt>, usize) {
        let (url, posts) = serve(response, hold).await;
        let (receipts, observer) = recorder();
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            observed_approval(answered(&url).await, OriginClass::Localhost, Some(observer)).await
        })
        .await
        .expect("the approval check never waits for an unread body");
        // Give an unexpected retry or redirect time to arrive before counting.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let receipts = receipts.lock().unwrap().clone();
        (result, receipts, posts.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn approval_succeeds_unchanged_without_a_receipt() {
        let (result, receipts, posts) = check(
            json(
                "200 OK",
                &[&format!("x-vercel-id: {VALID_ID}")],
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

    #[tokio::test]
    async fn unreadable_or_undecodable_success_bodies_keep_the_original_error() {
        // A truncated body is a read failure, not malformed JSON; both share
        // the one closed class and the original error.
        let truncated = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: 4096\r\n\r\n{\"approved\":true";
        for response in [
            json("200 OK", &[], &format!("not json {PRIVATE}")),
            json("200 OK", &[], ""),
            http("200 OK", &["content-type: text/html"], "<html>"),
            truncated.to_vec(),
        ] {
            let (result, receipts, posts) = check(response, false).await;
            assert_eq!(result, Err(INVALID_RESPONSE.to_string()));
            assert_eq!(posts, 1);
            assert_eq!(receipts.len(), 1);
            assert_eq!(
                (receipts[0].http_status, receipts[0].approval),
                (200, Approval::JsonError)
            );
            assert!(!serde_json::to_string(&receipts[0])
                .unwrap()
                .contains(PRIVATE));
        }
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
    async fn the_receipt_serializes_only_its_closed_schema() {
        let (_, receipts, _) = check(
            json(
                "403 Forbidden",
                &[
                    &format!("x-vercel-id: {VALID_ID}"),
                    &format!("x-request-id: {PRIVATE}"),
                    &format!("set-cookie: session={PRIVATE}"),
                ],
                &format!(r#"{{"error":"{PRIVATE}"}}"#),
            ),
            false,
        )
        .await;
        let wire = serde_json::to_value(&receipts[0]).unwrap();
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
        let serialized = wire.to_string();
        assert!(!serialized.contains(PRIVATE));
        assert!(!serialized.contains("127.0.0.1"));
        assert!(!serialized.contains("synthetic"));
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
            Some(|_: ResponseRejectionReceipt| panic!("observer failure")),
        )
        .await;
        assert_eq!(panicking, Err(NOT_AUTHORIZED.to_string()));

        let (sender, receiver) = std::sync::mpsc::channel();
        drop(receiver);
        let closed = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            Some(move |receipt| {
                let _ = sender.send(receipt);
            }),
        )
        .await;
        assert_eq!(closed, Err(NOT_AUTHORIZED.to_string()));

        let direct = observed_approval(
            answered(&url).await,
            OriginClass::Localhost,
            None::<fn(ResponseRejectionReceipt)>,
        )
        .await;
        assert_eq!(direct, Err(NOT_AUTHORIZED.to_string()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(posts.load(Ordering::SeqCst), 3);

        // Without an observer, every class keeps its original result.
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
                None::<fn(ResponseRejectionReceipt)>,
            )
            .await;
            assert_eq!(result, expected);
        }
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
