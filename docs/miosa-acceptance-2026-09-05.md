# MIOSA runtime fix acceptance — September 5, 2026

## Result

Follow-up at 16:39–16:44 UTC: with the user's approval, the old paused record
was preserved by renaming it (its ID and slug are unchanged), and a fresh
workspace was created under the canonical per-user name. The initial Preview
Agent acceptance passed on MIOSA, but a reconnect test exposed premature
completion in HackerAI's abortable command wrapper. The `setsid --wait` fix
preserves delayed output and the real exit status; see the follow-up below.

### Earlier acceptance result

Fresh sandboxes pass live acceptance through HackerAI's upgraded adapter. The
preview user's older paused workspace remains blocked by
`SANDBOX_NOT_RESTORABLE` (details below). E2B fallback and the Europe exclusion
remain unchanged. No rollout, template environment variable, or production
configuration was changed.

- Repository: PR #1185, `codex/miosa-sandbox-rollout`.
- Versions: `@miosa/sdk` **3.2.3**, `@miosa/cli` **1.3.4** (repository and global CLI).
- Template: `miosa-sandbox-docker`.
- Shape: **4 vCPU / 4,096 MiB / 20,480 MiB**, verified from returned resource data.
- Guest kernel: `6.1.155+`.
- Runtime: `hackerai-agent`, using the existing pinned HackerAI Docker image.
- Test window: **2026-09-05 15:22–16:00 UTC**.

## Live evidence

| Disposable sandbox                     | Ready, including image initialization | Result                                                                |
| -------------------------------------- | ------------------------------------: | --------------------------------------------------------------------- |
| `3b55860f-3e09-4951-ae4a-4ea8af4da5fa` |                              67.168 s | Core matrix passed; deletion verified                                 |
| `cf248c3b-d440-4e47-90e3-a2d1b905991f` |                              67.532 s | Core matrix passed; deletion verified                                 |
| `4429831f-1674-41cb-8008-c50133d8e1dc` |                              69.115 s | Core and extended matrices passed; deletion verified                  |
| `a0eaf2fa-4ef0-4081-a4f7-bd152860cf39` |                              63.095 s | Post-review core/extended retest passed; deletion verified            |
| `58d39c44-e382-4600-bd65-46f12970a441` |                              67.035 s | Final cancellation fix/core/extended retest passed; deletion verified |

The third create returned request ID `GNJ2OrUPmPE_iLYCxqqC`, operation ID
`ca08849a-0156-403c-b862-81418a4ea81a`, boot path `byoc_host_command`, and a
platform boot duration of 2,396 ms. Total readiness above includes pulling and
initializing the HackerAI tools image; it is not the VM boot duration alone.

Core matrix, passed on all five:

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

Extended matrix, passed on the third, fourth, and fifth sandboxes:

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

This is five fresh sandboxes, not the ten-create stress test requested in the
earlier engineering spec, and not proof of multi-node placement. Destruction was
tested after normal execution and a pause/resume cycle, not every lifecycle
failure state. Long-duration usage accuracy and failure-injected 502/503 recovery
remain unverified. Live adapter acceptance is separate from the deployed preview
chat journey; record that verification separately before calling rollout complete.

## Deployed preview verification

Commit `631ef556` deployed to Vercel Preview and Trigger worker `20260905.2`.
The real chat completed command, stream, file lifecycle, and interactive checks,
and its response survived reload. However, run
`run_06g74eflhk9u7bg567p9ulate1` logged `sandbox.provider: e2b`.
**This is not deployed MIOSA acceptance.** A local evaluation using the preview
PostHog project key returned `true` for the MIOSA flag and the same test user;
the worker's selection/fallback reason remains unverified. No flag or credential
was changed to force a passing result.

The branch alias resolved to `hackerai-oadwx4t7b-hackerai.vercel.app`. Its build
logs and Convex metadata identify the branch's actual backend as
`hackerai-development:hackerai-52290:preview/codex-miosa-sandbox-rollout`,
`https://dusty-kiwi-899.convex.cloud`. The configured default URL
`diligent-blackbird-710` is overridden by the existing Convex preview build;
Trigger receives the correct branch URL in its payload. This difference was
initially treated as a wrong-target alarm; the first test run was canceled
before tools executed, then the branch identity was verified before retrying.

Review follow-ups guard malformed stream payloads, preserve original errors
while awaiting cancellation cleanup, and allow an explicit acceptance-template
override. A subagent region mismatch now attempts a terminal reservation update
before loading any task content; its queued-reservation watchdog remains the
fallback if that control-plane update fails.
Cancellation polling now exits nonzero if the PID file never appears, rather
than reporting an unconfirmed stop as `AbortError`. A regression executes the
full missing-PID polling window, and the fifth live sandbox confirmed normal
cancellation still works. The final local suite passed 4,755 tests.

## Remaining platform issue: an older paused workspace cannot resume

An authenticated, read-only-command resume probe against the preview user's
existing sandbox failed before executing any command:

- UTC: **2026-09-05 15:51:37.060**.
- Sandbox: `109fefeb-978a-4458-8ea6-f31368f1dd95`.
- Template: `miosa-sandbox-docker`; shape 4 vCPU / 4,096 MiB / 20,480 MiB.
- SDK: `3.2.3`; error class `ValidationError`.
- HTTP **409**, code **`SANDBOX_NOT_RESTORABLE`**.
- Message: **`sandbox is paused but has no usable snapshot to restore; create a fresh sandbox`**.
- Request ID: **`GNJ3mAemR4-fDsEAOa6G`**.
- No new build or template was involved; the sandbox already existed and was
  paused. Readback confirmed it remained paused. It was not destroyed/replaced.

`getOrCreate` resumes the stable per-user sandbox before checking readiness, so
this error would trigger HackerAI's existing E2B fallback. This is a direct SDK
reproduction, not a retrieved error from the preview worker's fallback event;
that event-level correlation remains unverified.

Paste-ready support request:

> SDK 3.2.3 cannot resume existing Docker sandbox
> `109fefeb-978a-4458-8ea6-f31368f1dd95`. At 2026-09-05 15:51:37.060 UTC,
> `sandbox.resume()` returned HTTP 409, `SANDBOX_NOT_RESTORABLE`:
> "sandbox is paused but has no usable snapshot to restore; create a fresh sandbox".
> Request ID: `GNJ3mAemR4-fDsEAOa6G`. Template: `miosa-sandbox-docker`,
> 4 vCPU / 4 GiB / 20 GiB. Five new disposable sandboxes pass acceptance,
> including three fresh pause/resume checks, but this older workspace stays paused.
> Please determine why its snapshot is unusable and whether its files can be
> recovered. Do not delete the existing workspace without approval. Please also
> provide a supported replacement/migration procedure that preserves the old
> record and makes idempotent per-user acquisition recover safely.

## Preview replacement and abortable-stream follow-up

- Old record: `109fefeb-978a-4458-8ea6-f31368f1dd95`, still paused. Preserved
  name: `hackerai-849c4d7c0265fbd71711f90e-v2-preserved-20260905`; slug
  `109fefeb` unchanged. No old data was deleted or migrated.
- Replacement: `8129585f-2b7c-46f3-bb44-ea7aad9f967d`, canonical name
  `hackerai-849c4d7c0265fbd71711f90e-v2`, tools ready at 16:41:13 UTC.
  This is intentionally retained as the user's persistent Preview workspace.
- Preview chat: `5ab2b804-20bb-4f4b-9271-2d06ae16d25d`, deployment
  `hackerai-2za9ckd2w-hackerai.vercel.app`, Trigger worker `20260905.4`,
  verified Preview Convex URL `https://dusty-kiwi-899.convex.cloud`.
- Run `run_06g74siahml0ap7vdhhq1hqne1` completed successfully. Final log span
  `b2751c515eb8fb89` reports `sandbox.provider=miosa`, `sandbox.type=cloud`,
  boot reuse 1,979 ms. Tools, file create/read/delete and interactive PTY passed.
  Reload preserved the result. Test file deletion was independently verified.
- Reconnect run `run_06g74sp9op53ddupba071eo1e1` exposed missing final stdout.
  Direct adapter reproduction passed three times without an AbortSignal and
  failed three times with a non-aborted AbortSignal: the late stdout disappeared
  and completion incorrectly reported exit 0.
- Cause: `setsid` can fork when launched as a process-group leader inside Docker.
  Without `--wait`, its parent exits before the wrapped command completes.
  Agent foreground commands always pass a signal and therefore use this wrapper.
- Fix: `setsid --wait` retains process-group cancellation while waiting for the
  child and forwarding its exit status. Three live repetitions after the fix
  preserved both stdout markers, delayed stderr and exit 7. The acceptance script
  now explicitly tests a non-aborted signal with delayed output and nonzero exit.
- E2B fallback, European routing and environment settings remain unchanged.
  PostHog event-level absence of fallback has not been independently queried.
- Full post-fix live matrix passed on disposable sandbox
  `48c0d72b-6a91-4573-9f4f-337b6f93146d` (16:44:32–16:46:14 UTC), including
  abortable delayed output, cancellation, PTY, files, localhost scan, reconnect,
  background termination, usage, port exposure and pause/resume. Deletion was
  verified. Request ID `GNJ6fJISEp4Md2IBp-9D`; operation ID
  `5a46d636-9e73-4799-9849-6fec4827c4e6`. Targeted tests: 4 suites / 71 tests;
  TypeScript and formatting checks passed.

## Reproduce

Run from this checkout using the authenticated local CLI credential:

```sh
corepack pnpm exec tsx scripts/miosa-acceptance.mts --cli-auth --attempts=2
```

Alternatively omit `--cli-auth` and supply `MIOSA_API_KEY` securely through the
environment. This is a billable live test. It uses random synthetic users,
creates only disposable test data, and requests sandbox deletion in `finally`,
including after acquisition failure. It never changes deployment configuration.
An explicitly supplied `MIOSA_TEMPLATE_ID` is respected; otherwise the test uses
`miosa-sandbox-docker`, and the normal adapter initializes the pinned tools image.
If cleanup fails, the JSON result includes the synthetic external user ID for
targeted reconciliation. Never paste credentials into commands or support logs.
