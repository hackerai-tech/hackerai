---
name: hackerai-desktop-qa
description: Operate and verify HackerAI in the actual native Desktop app through Computer Use, with isolated QA builds, environment identity, findings, downloads, and recovery evidence. Use for Desktop acceptance or preparing an authorized in-app demo.
---

# HackerAI Desktop QA

This is developer tooling; it adds no product UI or runtime endpoint. It does
not grant access to Production, authorize scans, or replace human release gates.
The skill is versioned in this repository, not a private credential store.

## Select the surface and scope

Read the checkout's AGENTS.md and [Desktop acceptance runbook](../../../docs/desktop-local-acceptance.md).
Use the actual native app for native commands, sandbox transport, or Save dialogs.
Prefer a verified Vercel Preview for web-only changes. A local native shell can
load that Preview when its auth, CSP and remote capabilities support it; keep
those results distinct from a fully local backend/worker test. If a local
frontend is needed, finish building it before starting acceptance. Avoid another
watcher or build just to take screenshots.

For an explicitly authorized Production demo, use the installed Production app
and verify the signed-in account first. Preserve existing data. Prefer synthetic
examples labeled **Demo**, with a fictional `.invalid` target and an explicit
synthetic-evidence disclosure. Do not claim a real vulnerability was verified.
Do not launch a QA build against Production as a fallback for blocked auth.

## Prepare and inspect

Use [the QA runner](../../../docs/desktop-qa-tooling.md) to check a pinned native
executable, start it, optionally serve an existing local frontend build, and
collect local diagnostics. Reuse a suitable task-owned build; rebuild after
native changes. The runner does not install dependencies, build, provision
Convex, start a worker/relay, or copy credentials. Follow the runbook for those
operations only when needed.

Record the tested source revision and binary hash. Independently establish the
backend account/project/deployment and matching worker environment/branch before
using external test services. Configured identity and TCP reachability are not
proof of the backend or worker serving a run. Verify the actual frontend in the
native WebView, selected account, worker run and sandbox transport.

## Computer Use navigation

- Select the exact QA app path/window, not the installed app with a similar title.
  Read fresh accessibility state after actions; do not retain numeric element
  IDs between observations or hard-code screenshot coordinates across builds.
- Confirm the account through the user menu. A browser login is not a native
  WebView login. Never copy browser cookies or credentials into the app.
- Start a disposable chat. Preserve any unsent composer draft before replacing
  it. Select the intended Ask/Agent mode and **This computer** / Desktop sandbox.
- Use a bounded harmless command such as `printf 'DESKTOP_QA_OK\n'`. Verify its
  tool result and actual transport; the selector alone is insufficient.
- Use **Findings**, **Search findings**, and the category/status/severity filters.
  Open a finding from its title. Detail should expose severity, evidence,
  reproduction, remediation and source-message navigation. Use the current AX
  labels as authoritative if wording changes.
- For findings changes, exercise create/list/get/update via the Agent's tools.
  Improve the same finding and check stable ID/creation time, no duplication,
  stale-update rejection, missing evidence, and cross-chat authorization as
  relevant. Keep test target and request budget within the user's authorization.
- For **Download report**, cancel once, save through the native dialog, then
  inspect the actual saved Markdown and compare code, links, evidence and updated
  remediation. A dismissed dialog is not proof that the file was saved.

## Recovery and evidence

When the Mac is locked or login/2FA needs a human, explain that exact blocker.
Do not loop on passkey failures, disable protections, or call browser/cloud
success native acceptance. If a window stops responding, inspect the runner's
health and lifecycle status before restarting. Reload using a control or shortcut
confirmed by the current UI; do not assume browser shortcuts exist in Tauri.
Only stop/relaunch the task-owned QA session. Preserve run/chat IDs so reconnect
can be checked for retained results and duplicate writes.

Record observed run status and transport with `desktop:qa record`; label it as
operator-observed evidence, not backend telemetry. Capture relevant completion,
error, recovery, normal/narrow layout and download states through Computer Use.
Collapse the sidebar or filter demo data when preparing a screenshot; keep
synthetic disclosures visible and omit account menus, credentials and unrelated
customer content. Restore drafts and window dimensions when appropriate.

Report PASS/FAIL/BLOCKED per requested check with artifacts and defect steps.
Distinguish native/local, native/Preview, browser/cloud and Production evidence.
Stop each runner-owned session with `desktop:qa stop`; handle externally started
services separately from their own task ownership records. Retain useful partial
work and list anything intentionally left running. A successful runner launch,
unit test or screenshot does not establish end-to-end acceptance or authorize
merging, publication or release.
