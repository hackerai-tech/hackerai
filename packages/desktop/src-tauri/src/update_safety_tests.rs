//! Run the real command/file/PTY adapters in a separate test process so their
//! process-wide installation fence cannot interfere with concurrent unit tests.
use super::*;

#[test]
fn native_adapters_preserve_files_and_terminals_during_installation() {
    // A real native child holds a connection open until stopped. A byte from
    // the parent is only a cleanup escape for the red-before-fix case.
    if let Ok(port) = std::env::var("HACKERAI_HEADER_TEST_PORT") {
        use std::io::Read;
        #[cfg(unix)]
        unsafe {
            // The shell exits on TERM, but this descendant must require KILL.
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
        let mut connection = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        let _ = connection.read_exact(&mut [0u8]);
        return;
    }
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
            header_failure_reaps_command_before_update_admission().await;
            fs::remove_dir_all(root).unwrap();
        });
}

// Inject only transport failure; run the production handler and a real child.
struct FailedHeaders(tokio::sync::oneshot::Receiver<()>);
impl tokio::io::AsyncWrite for FailedHeaders {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        _: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        use std::future::Future;
        match std::pin::Pin::new(&mut self.0).poll(context) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready(_) => std::task::Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "test peer disconnected",
            ))),
        }
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

async fn header_failure_reaps_command_before_update_admission() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let executable = std::env::current_exe().unwrap();
    let mut command = format!("\"{}\" --exact update_safety_tests::native_adapters_preserve_files_and_terminals_during_installation", executable.display());
    // Keep the shell alive so this covers descendants, not exec replacement.
    command.push_str(if platform::get_shell_config().is_cmd {
        " & exit /b 0"
    } else {
        " ; exit 0"
    });
    let body = serde_json::json!({"command":command,"timeout_ms":5000,"env":{"HACKERAI_HEADER_TEST_PORT":listener.local_addr().unwrap().port().to_string()}}).to_string();
    let (ready, started) = tokio::sync::oneshot::channel();
    let mut transport = FailedHeaders(started);
    let (result, mut child_connection) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(handle_execute_stream(&body, &mut transport), async {
            let (connection, _) = listener.accept().await.unwrap();
            assert!(
                update_safety::UPDATE_GATE.install().is_err(),
                "running stream must block installation"
            );
            ready.send(()).unwrap();
            connection
        })
    })
    .await
    .expect("native child must start and header failure must return");
    assert!(result.unwrap_err().contains("test peer disconnected"));
    assert!(update_safety::UPDATE_GATE.install().is_ok());
    let mut byte = [0];
    let closed =
        tokio::time::timeout(Duration::from_millis(500), child_connection.read(&mut byte)).await;
    let stopped = match &closed {
        Ok(Ok(0)) => true,
        // TerminateProcess can close a Windows socket with RST instead of FIN.
        Ok(Err(error)) => matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
        ),
        _ => false,
    };
    if !stopped {
        // Avoid leaking the regression fixture even when the assertion fails.
        let _ = child_connection.write_all(&[1]).await;
        let _ =
            tokio::time::timeout(Duration::from_secs(5), child_connection.read(&mut byte)).await;
    }
    assert!(
        stopped,
        "header failure released update admission before the child connection closed: {closed:?}"
    );
}
