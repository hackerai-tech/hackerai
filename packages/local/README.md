# @hackerai/local

HackerAI Local Sandbox Client - Execute commands on your local machine from HackerAI.

## Quick Start

No installation or manual token handling is required:

1. Go to [HackerAI Settings](https://hackerai.co/settings)
2. Open "Remote Control"
3. Click "Copy connect command"
4. Paste and run the command in your terminal

The copied command runs the latest package with your authentication token
included automatically.

## Global Installation (Optional)

```bash
npm install -g @hackerai/local
```

After installation, copy the connect command from HackerAI Settings and replace
`npx @hackerai/local@latest` with `hackerai-local`. Leave the generated
arguments unchanged.

Commands run directly on your host OS. The client connects to HackerAI and relays commands in real-time.

## Options

| Option             | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `--token TOKEN`    | Authentication token included in the copied command (required) |
| `--name NAME`      | Optional connection name fallback (default: hostname)          |
| `--convex-url URL` | Override backend URL included for non-production environments  |
| `--help, -h`       | Show help message                                              |

## Security

Commands run directly on your OS without any isolation. Only connect machines you trust and control. The client auto-terminates after 1 hour of inactivity.

## Private terminal output storage

On POSIX hosts, the client enables private terminal saving only after checking
directory ownership and rejecting symlinks. If another OS user owns either
shared `/tmp/terminal_execution_records` or `/tmp/terminal_full_output` directory,
the client can use independently checked `-uid-<uid>` directories instead. It
keeps that established fallback on subsequent starts and leaves the blocked
shared directory untouched.

If both layouts are unavailable, saving stays disabled. Correct the reported
filesystem permissions or storage problem and restart the client. Do not use
`sudo` or remove another user's files to bypass the checks.

Release the backend schema and worker support for `privateArtifactNamespace`
before publishing a CLI that advertises it. A web/worker deployment alone does
not update installed CLI processes; restart them with the new package after
publishing.

## License

MIT
