# Desktop QA tooling

The repository skill `.agents/skills/hackerai-desktop-qa/SKILL.md` and
`pnpm desktop:qa` help an agent operate the native app without adding product
controls, runtime endpoints, telemetry, or dependencies. They run on macOS and
Linux. The skill is repository-visible developer guidance, not a place for
private keys or user data.

Use the [acceptance runbook](desktop-local-acceptance.md) for environment setup,
Tauri overrides, authentication and end-to-end checks. Use Vercel Preview for
web-only work to avoid competing local builds. For a local frontend, build once
before acceptance, using the existing documented build workflow. This runner
never builds or launches development watchers automatically.

## Prepare a launch record

Create `.artifacts/desktop-qa/config.json` in the task's worktree. It contains
only independently verified, non-secret identity metadata. For example:

```json
{
  "environment": "local",
  "frontend": "http://127.0.0.1:3100",
  "backend": {
    "account": "local",
    "project": "hackerai",
    "deployment": "local-worktree-name",
    "url": "http://127.0.0.1:3210"
  },
  "worker": {
    "project": "proj_example",
    "environment": "development",
    "branch": "desktop-qa-task",
    "version": "unverified"
  },
  "relay": "ws://127.0.0.1:8000",
  "app": {
    "executable": "packages/desktop/src-tauri/target/debug/bundle/macos/HackerAI Local QA.app/Contents/MacOS/hackerai-desktop",
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS",
    "sourceCommit": "REPLACE_WITH_40_CHARACTER_SOURCE_COMMIT",
    "version": "0.0.0"
  }
}
```

Use the actual executable path from your build, not the example filename. Obtain
its hash with `shasum -a 256 '<executable-path>'`; record the source commit and
embedded app version from the build, not merely the current checkout. The runner
checks the hash and resolves symlinks to enforce worktree containment. It does not
prove that operator-supplied source/version/environment labels are accurate.
Never relabel an old native binary as the new commit. If reusing a build artifact,
copy only the task-owned build, never installed dependencies or runtime secrets.

The native build must already target the declared frontend using the runbook's
explicit window URL, distinct QA identifier and disabled updater. Changing this
JSON does **not** change the binary's frontend or permissions. Verify the actual
loaded URL with Computer Use after launch.

For native tests against Preview, use `environment: "preview"`, the exact
HTTPS Vercel deployment origin and `worker.environment: "preview"`. Independently
verify the designated HackerAI Developer Convex account/project/deployment and
matching Trigger Preview before writing the record. The runner cannot infer
that mapping from hostnames or the word Preview. It deliberately makes no cloud
health requests and cannot bypass deployment protection. Production is excluded
from the launcher; an explicitly authorized Production UI task uses the installed
app directly.

## Launch, inspect and stop

Install this worktree's dependencies with `corepack pnpm install --frozen-lockfile`.
Start the backend, worker and relay through the acceptance runbook. Keep their
ownership records; this runner does not adopt them or read their credentials.

```bash
corepack pnpm desktop:qa doctor .artifacts/desktop-qa/config.json

# Optional, only after this worktree has a completed .next/BUILD_ID.
# Runs next start, never next dev/build. Keep this terminal alive.
corepack pnpm desktop:qa serve frontend-qa .artifacts/desktop-qa/config.json

# In another terminal, once the frontend is ready:
corepack pnpm desktop:qa start native-qa .artifacts/desktop-qa/config.json

# From another terminal:
corepack pnpm desktop:qa status native-qa
corepack pnpm desktop:qa record native-qa run_EXAMPLE completed desktop
corepack pnpm desktop:qa stop native-qa
corepack pnpm desktop:qa stop frontend-qa
```

An immediate clean native exit can mean the embedded Tauri single-instance
identifier matched an already running app. Check the actual window and lifecycle
log; do not count that as a new launch. Close only an idle task-owned QA instance,
or build with a distinct Tauri identifier. Renaming a bundle or its Info.plist
alone does not change that embedded identifier.

Use a fresh session name for each launch. The supervisor stays in the foreground;
closing its terminal normally sends a shutdown signal. Session directories are
exclusive and cannot silently adopt an earlier process. The stop command writes
a request for that live supervisor and waits for acknowledgment. It never reads
and kills a saved PID. An absent supervisor is reported as unacknowledged; inspect
task ownership manually rather than using broad `pkill` commands. Do not SIGKILL
the supervisor, which would prevent cleanup. Processes that intentionally daemonize
or escape the owned process group require separate ownership and cleanup; the
runner is designed for the foreground native executable and `next start`.

`serve` binds the configured loopback host and port. A busy port causes failure;
it never stops the existing server. The recorded Next build-ID hash identifies
which prebuilt output was launched, but does not attest its source commit or
build-time public environment. Verify those from the build record before reuse.

## Read diagnostics honestly

Files stay under the worktree's ignored `.artifacts/desktop-qa/<session>/`:

- `identity.json`: checkout commit, declared native source/version, verified
  executable hash, declared backend/worker/relay identities, host and load.
- `status.json`: supervisor lifecycle and heartbeat. A stale heartbeat means
  unknown, not stopped or healthy.
- `events.jsonl`: allowlisted process start/exit/stop events. Child stdout/stderr
  are discarded at the source, so prompts, tool output and arbitrary exception
  text cannot leak through a regex sanitizer. This is a lifecycle log, not a
  copy of application logs.
- `observations.jsonl`: bounded run ID, status and sandbox transport explicitly
  recorded by the operator after inspection. No automatic backend verification
  or application-content capture is implied.

The local frontend check sends a bounded, unauthenticated HEAD request without
following redirects or recording response bodies/headers. Backend and relay
checks only establish a local TCP listener; worker readiness, auth, native bridge
connectivity and actual run routing still need acceptance evidence. External
origins are labeled not probed. Diagnose application errors through authorized
service tools and record only safe correlation IDs, not raw customer content.

These files have owner-only permissions. They are local developer artifacts;
review screenshots and manually added evidence before sharing. No configuration
values or credentials are copied between worktrees or environments.

## Validation

Use `pnpm test:changed` for local iteration and commit checks. Jest runs only
tests related to uncommitted changes, in one process; the small Node tooling
suites run separately because Jest does not discover them. Staged, unstaged and
untracked files are included. This avoids repeating the full application suite
for a tooling or documentation correction. The hook still runs staged
lint/format checks and type checking. CI continues to run every test with
coverage and normal timeouts.

Changed-test selection cannot prove configuration changes or dynamic import
relationships. Run an explicit affected suite when needed and wait for full CI
before considering the PR ready. `pnpm test` remains available for an intentional
local full run. Avoid overlapping tests with builds, and investigate contention
instead of increasing test timeouts or retrying the full suite repeatedly.

Run `corepack pnpm test:desktop-qa` for containment/hash checks, environment and
credential rejection, bounded health probes, output privacy, process ownership
and shutdown escalation. Tests use disposable local processes and listeners.
For manual native validation, launch a verified QA build, inspect the exact
window with Computer Use, record the actual transport/run, stop the session and
confirm the QA process exits while unrelated apps/services remain running.
