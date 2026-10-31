//! Run the real command/file/PTY adapters in a separate test process so their
//! process-wide installation fence cannot interfere with concurrent unit tests.
use super::*;

#[test]
fn native_adapters_preserve_files_and_terminals_during_installation() {
    const CHILD: &str = "HACKERAI_UPDATE_ADAPTER_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "update_safety_tests::native_adapters_preserve_files_and_terminals_during_installation", "--nocapture"])
            .env(CHILD, "1")
            .output().unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root =
                std::env::temp_dir().join(format!("update-adapters-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            let target = root.join("notes.txt");
            fs::write(&target, b"keep my work").unwrap();
            let body =
                serde_json::json!({ "path": target, "allowed_root": root, "content": "changed" })
                    .to_string();
            let mut terminals = pty::PtyManager::new();
            terminals
                .create(
                    "update-test".into(),
                    String::new(),
                    80,
                    24,
                    None,
                    None,
                    tauri::ipc::Channel::new(|_| Ok(())),
                )
                .unwrap();
            assert!(update_safety::UPDATE_GATE.install().is_err());
            assert!(
                terminals.input_writer("update-test").is_ok(),
                "blocked update must leave terminal usable"
            );
            terminals.kill("update-test").unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let installation = loop {
                if let Ok(guard) = update_safety::UPDATE_GATE.install() {
                    break guard;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "closed terminal must release update fence"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            assert!(handle_file_write(&body)
                .await
                .err()
                .expect("installation must deny the operation")
                .contains("installing an update"));
            assert!(handle_file_append(&body)
                .await
                .err()
                .expect("installation must deny the operation")
                .contains("installing an update"));
            assert!(handle_file_remove(&body)
                .await
                .err()
                .expect("installation must deny the operation")
                .contains("installing an update"));
            assert!(
                execute_command("echo should-not-run".into(), None, None, None)
                    .await
                    .err()
                    .expect("installation must deny the operation")
                    .contains("installing an update")
            );
            assert!(handle_execute(r#"{"command":"echo should-not-run"}"#)
                .await
                .err()
                .expect("installation must deny the operation")
                .contains("installing an update"));
            assert!(terminals
                .create(
                    "blocked".into(),
                    String::new(),
                    80,
                    24,
                    None,
                    None,
                    tauri::ipc::Channel::new(|_| Ok(()))
                )
                .is_err());
            assert_eq!(fs::read(&target).unwrap(), b"keep my work");
            drop(installation); // Failed/canceled installer returns control without a permanent fence.
            handle_file_write(&body).await.unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"changed");
            let output = execute_command("echo UPDATE_RETRY_OK".into(), None, None, Some(5000))
                .await
                .unwrap();
            assert!(output.stdout.contains("UPDATE_RETRY_OK"));
            fs::remove_dir_all(root).unwrap();
        });
}
