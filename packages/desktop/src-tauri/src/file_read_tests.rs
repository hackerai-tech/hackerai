use serde_json::{json, Value};

const DEFAULT_CAP: usize = 1024 * 1024;

struct Fixture {
    root: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hackerai-file-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    async fn read(&self, bytes: &[u8], mut request: Value) -> Value {
        let path = self.root.join(format!("{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        request["path"] = json!(path);
        let response = crate::handle_file_read(&request.to_string()).await.unwrap();
        serde_json::from_str(&response).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn content(response: &Value) -> &str {
    response["content"].as_str().unwrap()
}

#[tokio::test]
async fn file_read_drops_a_valid_character_split_by_the_default_cap() {
    let fixture = Fixture::new();
    let mut bytes = vec![b'a'; DEFAULT_CAP - 1];
    bytes.extend_from_slice("€tail\n".as_bytes());

    let response = fixture.read(&bytes, json!({"range_start": 1})).await;

    let text = content(&response);
    let tail = &text[text.len().saturating_sub(4)..];
    // Compare length and tail first so a failure does not print a megabyte.
    assert_eq!((text.len(), tail), (DEFAULT_CAP - 1, "aaaa"));
    assert!(text == "a".repeat(DEFAULT_CAP - 1));
    assert_eq!(response["truncated"], true);
    assert_eq!(response["startLine"], 1);
}

#[tokio::test]
async fn file_read_keeps_output_within_small_caps() {
    let fixture = Fixture::new();
    // (source bytes, request, expected content, expected truncated)
    let cases: [(&[u8], Value, &str, bool); 8] = [
        // Valid characters split by the cap are dropped whole.
        ("aé".as_bytes(), json!({"max_result_bytes": 2}), "a", true),
        ("ab€".as_bytes(), json!({"max_result_bytes": 4}), "ab", true),
        ("a😀".as_bytes(), json!({"max_result_bytes": 4}), "a", true),
        // A selected range keeps its own lines when the cap splits one.
        (
            "one\ntwo€\nthree\n".as_bytes(),
            json!({"range_start": 2, "range_end": 3, "max_result_bytes": 5}),
            "two",
            true,
        ),
        // Exact fit and plain ASCII are unchanged.
        (
            "a\n€".as_bytes(),
            json!({"max_result_bytes": 5}),
            "a\n€",
            false,
        ),
        (b"abcdef", json!({"max_result_bytes": 3}), "abc", true),
        // Genuine invalid source bytes stay visible as replacements, and the
        // cap counts their encoded size.
        (
            b"a\xff\xe2\x82\xac",
            json!({"max_result_bytes": 4}),
            "a\u{FFFD}",
            true,
        ),
        (b"a\xff\xffb", json!({"max_result_bytes": 3}), "a", true),
    ];

    let mut failures = Vec::new();
    for (bytes, request, expected, truncated) in cases {
        let response = fixture.read(bytes, request.clone()).await;
        let actual = (content(&response), response["truncated"].as_bool());
        if actual != (expected, Some(truncated)) {
            failures.push(format!(
                "{bytes:?} {request}: got {actual:?}, want {:?}",
                (expected, truncated)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn file_read_preserves_uncapped_invalid_bytes_and_range_metadata() {
    let fixture = Fixture::new();

    let response = fixture
        .read(
            b"skip\na\xffb\r\nlast\n",
            json!({"range_start": 2, "range_end": 2}),
        )
        .await;

    assert_eq!(content(&response), "a\u{FFFD}b\r\n");
    assert_eq!(response["truncated"], false);
    assert_eq!(response["startLine"], 2);
    assert_eq!(response["totalLines"], 3);
}
