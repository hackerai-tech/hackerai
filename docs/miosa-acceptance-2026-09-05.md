# MIOSA runtime fix acceptance — September 5, 2026

## Result

The upgraded SDK and current platform passed live acceptance through HackerAI's
adapter. E2B fallback and the Europe exclusion remain unchanged. No rollout,
template environment variable, or production configuration was changed.

- Repository: PR #1185, `codex/miosa-sandbox-rollout`.
- Versions: `@miosa/sdk` **3.2.3**, `@miosa/cli` **1.3.4** (repository and global CLI).
- Template: `miosa-sandbox-docker`.
- Shape: **4 vCPU / 4,096 MiB / 20,480 MiB**, verified from returned resource data.
- Guest kernel: `6.1.155+`.
- Runtime: `hackerai-agent`, using the existing pinned HackerAI Docker image.
- Test window: **2026-09-05 15:22–15:28 UTC**.

## Live evidence

| Disposable sandbox                     | Ready, including image initialization | Result                                               |
| -------------------------------------- | ------------------------------------: | ---------------------------------------------------- |
| `3b55860f-3e09-4951-ae4a-4ea8af4da5fa` |                              67.168 s | Core matrix passed; deletion verified                |
| `cf248c3b-d440-4e47-90e3-a2d1b905991f` |                              67.532 s | Core matrix passed; deletion verified                |
| `4429831f-1674-41cb-8008-c50133d8e1dc` |                              69.115 s | Core and extended matrices passed; deletion verified |

The third create returned request ID `GNJ2OrUPmPE_iLYCxqqC`, operation ID
`ca08849a-0156-403c-b862-81418a4ea81a`, boot path `byoc_host_command`, and a
platform boot duration of 2,396 ms. Total readiness above includes pulling and
initializing the HackerAI tools image; it is not the VM boot duration alone.

Core matrix, passed on all three:

- Executable running state, exact shape, and installed nmap/nuclei/ffuf/agent-browser.
- Streaming stdout, stderr, and exit code 7; exact partial chunks, Unicode,
  carriage returns, and trailing blank lines without inserted newlines.
- File write/read/stat/remove and shell interoperability at `/home/user`, `/tmp`,
  `/workspace`, and relative paths, including spaces, quotes, and Unicode.
- Binary upload larger than 1 MiB verified by SHA-256; transfer files cleaned up.
- Foreground cancellation rejected with `AbortError`; a delayed child-process
  marker remained absent after its scheduled execution time.
- Interactive terminal entered the tools container with environment options;
  input, output, resize to 111 columns × 37 rows, Ctrl-C, and cleanup passed.
- Localhost-only SYN scan and headless browser rendering passed.
- Reconnection returned the same sandbox and preserved its file.
- The helper used by Settings deletion removed the synthetic user's sandbox;
  a subsequent list confirmed no non-destroyed sandbox remained.

Extended matrix, passed on the third sandbox:

- Background PID and kill; delayed marker did not appear.
- Attributable, non-decreasing runtime and estimated cost across two samples.
- A disposable HTTP server inside Kali was reachable through `getHost(8765)`.
- Pause settled, reconnect resumed the same sandbox, and `/home/user` survived.

`miosa doctor --json` reported healthy connectivity and credentials. Optional MCP
setup warnings were unrelated to sandbox execution. Template readiness reported
all 10 nodes Docker-capable and cold-boot-capable, 0 unavailable, and 0 warm-ready
nodes across the listed named sizes. This is not an exact custom-shape capacity
guarantee, and the API evidence collected here does not identify distinct fleet
nodes.

## HackerAI fixes

- Pass the execution's abort signal to the new SDK and await cancellation cleanup.
- Preserve stream text rather than append a newline to each callback chunk.
- Route file operations into the same Kali container as commands. The shared
  home directory is a temporary binary-transfer channel, not a path restriction.
- Authenticate terminal WebSockets with session-scoped `stream_auth` and the
  `miosa-terminal-v1` subprotocol. Confirm entry into Kali before exposing the PTY.
- Enable interactive sessions and advertise the tools actually installed in the
  pinned runtime. Preserve E2B behavior and cloud-provider eligibility gates.
- Treat a WebSocket close as an unknown process exit status, not proof of exit 0;
  surface terminal deletion failures so callers can retry.

## Corrections and limits

The earlier line-normalization finding was caused by HackerAI's adapter, not
proven to be a MIOSA platform defect. The older provisioning error is consistent
with the SDK's stale local-state bug; it does not by itself prove that the VM
never became ready. The current upgraded path did not reproduce either problem.

This is three fresh sandboxes, not the ten-create stress test requested in the
earlier engineering spec, and not proof of multi-node placement. Destruction was
tested after normal execution and a pause/resume cycle, not every lifecycle
failure state. Long-duration usage accuracy and failure-injected 502/503 recovery
remain unverified. Live adapter acceptance is separate from the deployed preview
chat journey; record that verification separately before calling rollout complete.

## Reproduce

Run from this checkout using the authenticated local CLI credential:

```sh
corepack pnpm exec tsx scripts/miosa-acceptance.mts --cli-auth --attempts=2
```

Alternatively omit `--cli-auth` and supply `MIOSA_API_KEY` securely through the
environment. This is a billable live test. It uses random synthetic users,
creates only disposable test data, and requests sandbox deletion in `finally`,
including after acquisition failure. It never changes deployment configuration.
If cleanup fails, the JSON result includes the synthetic external user ID for
targeted reconciliation. Never paste credentials into commands or support logs.
