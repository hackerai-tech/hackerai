use base64::Engine;
use tokio::io::AsyncWriteExt;

// Bound IPC memory without putting response tokens into argv, env or files.
const MAX_INPUT_BYTES: usize = 1024 * 1024;

pub fn decode(input: Option<String>, encoding: Option<String>) -> Result<Option<Vec<u8>>, String> {
    let Some(input) = input else { return Ok(None) };
    if input.len() > MAX_INPUT_BYTES * 2 {
        return Err("Command stdin exceeds limit".into());
    }
    let bytes = match encoding.as_deref().unwrap_or("utf8") {
        "utf8" => input.into_bytes(),
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(input)
            .map_err(|_| "Invalid command stdin encoding")?,
        _ => return Err("Invalid command stdin encoding".into()),
    };
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("Command stdin exceeds limit".into());
    }
    Ok(Some(bytes))
}

pub async fn write(
    pipe: Option<tokio::process::ChildStdin>,
    input: Option<Vec<u8>>,
) -> std::io::Result<()> {
    if let Some(input) = input {
        let mut pipe = pipe.ok_or_else(|| std::io::Error::other("Command stdin unavailable"))?;
        pipe.write_all(&input).await?;
        pipe.shutdown().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_or_oversized_input_without_echoing_it() {
        assert!(decode(Some("private input".into()), Some("unsupported".into())).is_err());
        assert!(decode(Some("private input".into()), Some("base64".into())).is_err());
        assert!(decode(Some("x".repeat(MAX_INPUT_BYTES + 1)), None).is_err());
        assert_eq!(
            decode(Some("AP8=".into()), Some("base64".into())).unwrap(),
            Some(vec![0, 255])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sends_binary_input_and_eof_without_shell_interpolation() {
        let mut child = tokio::process::Command::new("cat")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let input = b"\0private $HOME `command`\xff\n".to_vec();
        let writer = write(child.stdin.take(), Some(input.clone()));
        let (written, output) = tokio::join!(writer, child.wait_with_output());
        written.unwrap();
        assert_eq!(output.unwrap().stdout, input);
    }
}
