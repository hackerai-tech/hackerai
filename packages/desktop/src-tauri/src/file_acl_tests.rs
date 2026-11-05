use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};

fn invoke_file(
    window: &tauri::WebviewWindow<MockRuntime>,
    origin: &str,
    request: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: "desktop_file_request".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: origin.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(json!({"request": request})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

// The previous dispatcher tests bypassed Tauri's ACL entirely. Exercise the
// actual compiled app context: a registered Rust handler is not a permission.
#[test]
fn compiled_acl_allows_production_file_access_and_preserves_denial_boundaries() {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![crate::desktop_file_request])
        .build(crate::app_context())
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .unwrap();
    let root = std::env::temp_dir().join(format!("hackerai-acl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("notes.txt");
    let request = json!({"type":"file_write", "path":file, "content":"saved", "allowed_root":root});

    for origin in [
        "https://hackerai.co/",
        "https://hackerai.co/chat/example?desktop=true",
    ] {
        assert_eq!(
            invoke_file(&main, origin, request.clone()).unwrap(),
            json!({"ok":true})
        );
        let read = invoke_file(
            &main,
            origin,
            json!({"type":"file_read", "path":file, "max_full_bytes":1024,"max_result_bytes":1024}),
        )
        .unwrap();
        assert_eq!(read["content"], "saved");
    }
    let rejected_write = json!({"type":"file_write", "path":file, "content":"must not overwrite", "allowed_root":root});
    for origin in [
        "https://untrusted.invalid/",
        "https://hackerai.co.untrusted.invalid/",
        "https://untrusted.hackerai.co/",
    ] {
        assert!(invoke_file(&main, origin, rejected_write.clone()).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "saved");
    }
    assert!(invoke_file(&other, "https://hackerai.co/", rejected_write).is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "saved");
    std::fs::remove_dir_all(root).unwrap();
}
