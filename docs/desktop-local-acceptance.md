# Local Desktop acceptance

Use this workflow when changing Desktop behavior, native commands, or the
Desktop sandbox transport. It verifies the affected journey in the native app;
browser/cloud verification must be recorded separately. For shared Ask/Agent or
provider changes, also check the other affected callers and transports.

## Prepare an isolated checkout

1. Verify the host and graphical access. On the Mac mini, use the native macOS
   app. Preserve the installed app, existing changes, and unrelated services.
2. Read the checkout's AGENTS.md, root README/package scripts, and Desktop
   README/package scripts/Tauri configuration. Scripts and configuration in the
   tested commit are authoritative if documentation disagrees.
3. Reuse a suitable task-owned worktree or create one at the intended revision.
   Install its own dependencies:

   ```bash
   corepack pnpm install --frozen-lockfile
   corepack pnpm run check:local-dependencies
   ```

   Never share installed node_modules links between checkouts. Repair an external
   dependency link with `corepack pnpm install --force --frozen-lockfile`.

4. Populate this worktree's `.env.local` from approved Development sources using
   `.env.local.example` as a field reference. Never copy `.env.local` or `.convex`
   from another checkout. Inspect names, presence, environment identity, and
   fingerprints, not secret values. Do not print full process arguments or use
   the clipboard to transfer credentials.
5. Allocate available ports and task-specific worker/container names. Record
   original selections before changing configuration. Keep QA files and evidence
   under the worktree's ignored `.artifacts/desktop-qa/` directory.
   Before starting Centrifugo, set the task-owned relay's `allowed_origins` to
   include the exact frontend origin, such as `http://localhost:<frontend-port>`
   for an alternate port. The reference config allows localhost port 3000.

## Start and verify each service

Run these from the repository root in separate terminals:

```bash
# Next.js and worktree-local Convex
corepack pnpm run dev:local

# Local Agent worker, after verifying the Development project and key
TRIGGER_DEV_BRANCH=desktop-qa corepack pnpm run dev:trigger --env-file .env.local --max-concurrent-runs 1

# Native development app using the repository's local dev configuration
corepack pnpm run desktop:dev
```

Replace `desktop-qa` with a task-specific branch. Configure the Next.js request
path to route to that same branch using the current Trigger SDK configuration
(currently `TRIGGER_PREVIEW_BRANCH` in the frontend environment). Verify the
actual run's worker branch rather than relying on the CLI's ready message.
`TRIGGER_DEV_BRANCH` is read by the worker launcher before `--env-file` is loaded,
so pass it in the launch environment as shown. Verify `TRIGGER_PROJECT_ID` and
that `TRIGGER_SECRET_KEY` is a Development key (`tr_dev_…`). Keep the local worker
on the same backend and relay as the frontend.

`dev:local` runs the dependency guard and selects an existing local Convex
deployment, creating one only when the CLI reports none for this worktree. Do
not pre-create or copy local state. Record the selected deployment name, local
storage directory, backend version, and actual cloud/site ports. Ensure the
frontend and worker use its URL. Configure required WorkOS/auth and application
service-key variables on that local backend through protected secret input.
The application `CONVEX_SERVICE_ROLE_KEY` is separate from the local backend's
instance secret/admin credential; do not assume they are interchangeable.

The local sandbox requires a relay. Use `docker/centrifugo/config.json` and
`docker/centrifugo/docker-compose.yml` as references for a task-owned instance; bind its exposed
ports to loopback and use only the local app's origins. Verify both the client
WebSocket URL and any API consumers. The container's
`CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` must match this worktree's
`CENTRIFUGO_TOKEN_SECRET`; retain its required API key as well. Supply secrets
without literal values in shell arguments or output. Recreating a container
must preserve its environment and configuration, not just its ports.

Development auth, model APIs, and the Trigger control plane may remain external;
this is not a fully offline stack. If Preview services are required, independently
verify the designated HackerAI Developer Convex account/project/deployment and
matching Vercel and Trigger Preview targets before accessing them. Never use
Production or another deployment as a fallback. An unexpectedly empty cloud
target is a wrong-target alarm, not permission to seed it.

## Use a distinct native QA app

The standard development configuration points at localhost, but review its CSP
and remote capabilities against the actual backend/relay ports. When isolation
or a packaged app is needed, create a task-owned JSON override at
`.artifacts/desktop-qa/tauri.local.json`. For example:

```json
{
  "productName": "HackerAI Local QA",
  "identifier": "co.hackerai.desktop.localqa",
  "build": { "devUrl": "http://localhost:3000" },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "HackerAI Local QA",
        "url": "http://localhost:3000",
        "width": 1280,
        "height": 800,
        "resizable": true
      }
    ]
  },
  "plugins": { "updater": { "endpoints": [] } },
  "bundle": { "createUpdaterArtifacts": false }
}
```

Choose a task-specific identifier/title and substitute the verified frontend
port. This override merges with the base Tauri configuration; it does not grant
new permissions. Check the merged CSP, remote URL scopes, native command bridge,
and authentication/deep-link behavior. Add only the necessary local scopes in
the QA override; do not weaken the installed app's permissions.

From the repository root, run either the native development process or build:

```bash
corepack pnpm --dir packages/desktop run tauri dev --config ../../.artifacts/desktop-qa/tauri.local.json

APP_URL=http://localhost:3000 corepack pnpm --dir packages/desktop run tauri build --debug --config ../../.artifacts/desktop-qa/tauri.local.json
```

The Desktop package also offers `build:dev`. Explicitly verify the resulting app
loads the local frontend: the build script replaces `__APP_URL__` in index.html,
and an already substituted file will not be rewritten to a new URL. The QA
override's explicit window URL avoids relying on that placeholder. Preserve and
restore any generated tracked-file changes after building. Launch the resulting
debug bundle from `packages/desktop/src-tauri/target/debug/bundle/` without
replacing the installed app. Record its executable hash and app version. Never
use `dev:prod`, `build:prod`, signing, updater promotion, or release commands for
local acceptance.

## Exercise the actual Desktop journey

Use Computer Use in the native window. The browser preference applies to browser
testing; a browser tab cannot substitute for native acceptance.

- Use an authorized Development test account; follow the repository's test-user
  configuration where applicable. If sign-in, 2FA, or a locked Mac needs human
  action, explain the exact blocker. Do not request passwords/codes in chat or
  copy browser sessions into the native WebView.
- Select **This computer** / Desktop sandbox. Run a harmless marker such as
  `printf 'DESKTOP_QA_OK\n'` and confirm commands actually use the Desktop bridge
  and expected host. Selection or a relay connection alone is insufficient.
- Create a disposable chat and submit a bounded request through the affected
  Ask/Agent path. Verify activity/tool results, rendering, completion, and saved
  output. Exercise the changed provider or native command where relevant.
- Reload/reconnect during a run when relevant and after completion. Confirm
  completed work and updates remain available without duplicate writes.
- Exercise relevant cancellation/retry, validation, stale-update, authorization,
  and backend-error paths. Failed/canceled writes must not create unwanted data
  or overwrite saved results. Restore any controlled fault injection exactly.
- For file/export changes, cancel the native Save dialog, then save to a chosen
  path, open the file, and compare evidence, code, links, and updated content.
  Exercise failed replacement if existing-file preservation is affected.
- Inspect normal and narrow native windows; restore their original dimensions.
  Save screenshots of meaningful success, error, and recovery states.
- Rebuild/relaunch after native-code changes and repeat affected checks against
  the final commit. An earlier build does not verify the final native code.

Use only explicitly authorized targets and request budgets. Do not invent
pentest scope to obtain acceptance evidence.

## Record results and leave a reviewable state

For every check, record **PASS**, **FAIL**, or **BLOCKED**, with evidence and
reproduction steps for defects. Record the source commit, native build/hash,
frontend URL, backend deployment/storage/version, worker project/environment/
branch/version, relay, account environment, and observed sandbox transport.
Never include credentials in logs, screenshots, or artifacts.

Distinguish native/local results from browser/cloud results. Fixtures, unit
tests, CI, and screenshots alone do not prove a complete workflow. Preserve
useful partial evidence when blocked. Follow required CI/CodeRabbit procedures;
retain researcher-feedback and human release gates. Testing does not authorize
merging, publishing, or releasing.

Restore temporary source/configuration changes and verify the original
selections. Stop only task-owned services that are no longer needed; report any
intentionally retained processes, containers, credentials, test files, or local
state. Keep this runbook outside `packages/desktop/`: that directory's workflow
path filter triggers a signed native build on main even for README changes.
