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
fn compiled_acl_denies_direct_remote_file_and_shell_access() {
    let app = mock_builder()
        .manage(crate::SelectedLocalFiles(std::sync::Mutex::new(
            std::collections::HashSet::new(),
        )))
        .invoke_handler(tauri::generate_handler![
            crate::desktop_file_request,
            crate::execute_command,
            crate::read_local_file
        ])
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
    let secret = root.join("private.txt");
    std::fs::write(&secret, b"private content").unwrap();
    let request = json!({"type":"file_write", "path":file, "content":"saved", "allowed_root":root});

    for origin in [
        "https://hackerai.co/",
        "https://hackerai.co/chat/example?desktop=true",
        "https://untrusted.invalid/",
        "https://hackerai.co.untrusted.invalid/",
        "https://untrusted.hackerai.co/",
    ] {
        let file_denial = invoke_file(&main, origin, request.clone()).unwrap_err();
        assert!(file_denial.to_string().contains("not allowed"));
        let shell = get_ipc_response(
            &main,
            tauri::webview::InvokeRequest {
                cmd: "execute_command".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: origin.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({"command":"echo should-not-run"})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        let shell_denial = shell.unwrap_err();
        assert!(shell_denial.to_string().contains("not allowed"));
        if origin.starts_with("https://hackerai.co/") {
            let read = get_ipc_response(
                &main,
                tauri::webview::InvokeRequest {
                    cmd: "read_local_file".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: origin.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(json!({"path":secret})),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            );
            assert!(read.unwrap_err().to_string().contains("Select this file"));
        }
        assert!(!file.exists());
    }
    assert!(invoke_file(&other, "https://hackerai.co/", request).is_err());
    assert!(!file.exists());
    std::fs::remove_dir_all(root).unwrap();
}
