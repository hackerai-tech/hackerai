# Abuse email intake

`/abuse` accepts signed-out reports and appeals and queues their complete contents
for plain-text email to `abuse@hackerai.co`. New submissions do not create cases or
change accounts. The custom `/abuse/operations` UI has been removed. Submitted
links remain text; the service does not fetch them or generate attachments.

## Configuration

Configure Preview and Production independently. Before enabling public intake,
assign a mailbox owner and backup, verify delivery and monitoring, and record an
approved retention policy in the owning internal issue. The technical defaults
below are not a claim about legally required retention.

- Web and Convex: `ABUSE_EVIDENCE_KEYS`, the same environment-specific JSON keyring
  with `active` key ID and `keys` mapping IDs to 32-byte hexadecimal keys. Retain
  old keys while queued payloads, receipt retries, or retained historical case
  evidence and notes depend on them. Before retirement, an authorized backend
  review must check all those dependencies; queue expiry alone does not prove a
  historical key is unused. Keep the key if that check is incomplete. Update both
  consumers together, without copying keys between environments.
- Web and Convex: `ABUSE_INTAKE_ENABLED=true`. Missing configuration fails closed.
- Convex only: `ABUSE_SMTP_PASSWORD`, a dedicated Proton SMTP token paired with
  `abuse@hackerai.co`. Use separate tokens for Preview and Production, not a mailbox
  login password. SMTP uses Proton's fixed host/port, mandatory STARTTLS and
  certificate verification. Removing this token pauses queued work and rejects
  new reports. It is not needed in Vercel or Trigger.
- Web only: `ABUSE_TURNSTILE_SITE_KEY`, `ABUSE_TURNSTILE_SECRET_KEY`, and
  `ABUSE_TURNSTILE_HOSTNAMES` (comma-separated exact hostnames). Use a dedicated
  Cloudflare Managed widget with matching hostnames and no pre-clearance.
  Published dummy keys are rejected. Keep Preview and Production separate.
- Web only: `ABUSE_EMAIL_VERIFIED=true` displays the mailbox address after delivery
  and monitoring have been independently verified.

Web settings require a deployment. The email-only flow does not use
`ABUSE_NOTIFICATIONS_ENABLED`, `ABUSE_NOTIFICATION_ENVIRONMENT`,
`ABUSE_NOTIFICATION_REVIEW_URL`, or `ABUSE_OPERATOR_USER_IDS`. The latter remains
required in Convex by the authorized case backend and operator CLI described below.

## Security check and receipts

The web API validates report fields and Cloudflare Siteverify before enqueueing,
requiring the configured hostname and `abuse_report` action. Missing, expired,
reused or mismatched tokens fail closed, including a seven-second provider timeout.
Tokens never enter encrypted payloads, fingerprints or analytics; report contents
are not sent to Siteverify. The intake route suppresses product analytics and Intercom startup.

The form refreshes expired challenges and preserves fields after errors. A lost
response can be retried with the same submission ID and a renewed challenge. The
receipt confirms durable queueing, not delivery or a decision. Matching receipt
retries do not enqueue duplicates during the 30-day receipt retention window.
Changed content with the same ID is rejected. An expired unsent payload returns
410; the form preserves fields and requires an explicit new submission.
Never disable verification to work around a provider outage.

## Delivery and temporary storage

One Convex transaction stores an encrypted report in `abuse_notifications` and
schedules a Node action. Scheduler arguments contain only its notification ID.
New intake requires an SMTP token and a keyring containing the envelope's key.
Decryption and bounded report validation happen before SMTP. Missing keys or
corrupt ciphertext fail closed without sending.

The plain-text message includes report/appeal type, reference, receipt time,
contact email, target, incident time, source IP/port, protocol, related reference,
description and full submitted evidence/links. Empty optional fields are marked.
Recipients and headers are fixed; no HTML, attachments, challenge tokens, keys or
internal notes are included.

When the finish transaction records SMTP acceptance, it removes the queued report
ciphertext, leaving reference, digest, timestamps, delivery status and attempt
count. Lost acknowledgements or interrupted finish transactions can leave delivery
uncertain, retaining the payload until confirmed-sent reconciliation or expiry
cleanup. Retained encrypted payloads expire after seven days; minimal receipts
expire after 30 days. A bounded five-minute maintenance sweep deletes expired data
even while SMTP is disabled. If an expired payload still has an active two-minute
send lease, cleanup waits until that lease ends. Rate-limit hashes expire
separately after their short window.
These are application-level deletion rules, not guarantees about provider backups
or platform execution logs. Review those services' retention separately.

The abuse mailbox and replies are the working record. Queue deletion does not
erase delivered emails, quoted copies or forwarded messages; their retention and
deletion need a separately approved mailbox policy. Historical case evidence is
not deleted by this queue policy.

## Delivery recovery

Inspect the authorized Convex dashboard's `abuse_notifications` status index.
`sent` means Proton accepted the message; verify the intended inbox separately.
Explicit transient rejection and preflight connection failures retry up to five
attempts with increasing delays. Permanent failure remains `failed`. A five-minute
sweep resumes paused work and recovers pending actions dropped before claim,
waiting beyond the longest retry delay. A stable Message-ID helps reconciliation.

Lost acknowledgements after DATA and expired send leases become `uncertain` and
are never automatically resent. Check the reference in the recipient inbox and
Proton Sent folder, recording the result internally before either recovery action:

- `abuseNotifications:retryFailed` accepts an exact notification ID and current
  `expectedAttempts` only for a confirmed failed entry with retained payload.
- `abuseNotifications:reconcileUncertain` accepts that same fence and a decision
  of `confirmed_sent` (marks sent and erases payload without sending) or
  `confirmed_not_sent` (schedules a send only with retained payload and SMTP).

These are internal admin mutations, not public APIs. Expired payloads cannot be
retried. The automatic attempt budget is not reset by an explicit recovery.
Monitor failed, uncertain and expired entries before their recovery window ends.

## Pausing and rollback

Disable `ABUSE_INTAKE_ENABLED` in both web and Convex and deploy the web change.
Removing `ABUSE_SMTP_PASSWORD` pauses sends. Keep the compatible queue schema,
handlers and five-minute maintenance cron running while intake/delivery is paused,
so encrypted payloads and receipts can still expire. New notification rows have no
`caseId`, including receipts retained after a successful send. Before restoring an
older required-`caseId` schema, an authorized backend inspection must confirm all
such rows have expired and been removed or have been handled through a separately
approved migration. Waiting 30 days alone is insufficient evidence of cleanup.
Until validation can succeed, retain the compatible schema and maintenance; do not
revert the entire backend or delete unfamiliar rows to force a rollback.

## Verification

Use synthetic data and the designated Preview environment. Verify real mailbox
arrival, one queue row across receipt retries, no new case, full text without HTML
or fetched links, and absent ciphertext after acceptance. Exercise missing SMTP,
corrupt ciphertext, transient/permanent rejection, uncertain acknowledgement,
failed recovery, expiry and receipt cleanup. Verify the actual form on desktop and
narrow screens with its dedicated Managed widget; check script failure, expiry,
field preservation and a lost-response retry. Public launch remains separate from
code merge and requires the operational ownership and policy decisions above.

## Historical cases and containment

Historical operations require `ABUSE_OPERATOR_USER_IDS` in both web and Convex,
with the appropriate historical `ABUSE_EVIDENCE_KEYS` retained in their secret
stores. Ordinary support membership grants no access.

1. Use the retained `POST /api/internal/abuse` endpoint through an approved
   same-origin operator client with an allowlisted WorkOS session. Its `read`
   action accepts the full `AB-…` reference and an optional pagination cursor;
   it checks both operator allowlists and creates an audit event. The server
   invokes `decryptAbuseEvidence(reference, ciphertext)` for case evidence and
   each encrypted event, using the environment's keyring from its secret store,
   then returns readable `case.report` and event `detail` fields. Keep results
   inside the approved restricted review workspace; never copy keys or evidence
   into command arguments, logs, analytics, public tickets or unapproved exports.
   Direct signed `abuseCases.read` calls return ciphertext; `abuseCases.list`
   returns metadata. Neither should be mistaken for a decrypted evidence view.
   Treat submitted fields as allegations.
2. Record verified attribution separately from allegations and decisions. Check the
   source address **and source port**, timezone, protocol, provider records, and the
   exact account, chat, root run, region, and selected sandbox. An IP alone is not
   reliable attribution for shared infrastructure.
3. Preserve only the minimum evidence needed for the case, with the reason, source,
   observation time, reviewer, and review date. Do not paste credentials into notes.
   Provider logs need their own scoped preservation process; case storage and an
   optional sandbox snapshot do not guarantee provider logs are retained.
4. For an appeal, review the original decision and new facts. Resolve only the
   identified case restriction after the review; appeals never lift it automatically.

## Containment and recovery

The operator's containment action requires the selected root to remain the chat's
active run. It deliberately rejects a completed or replaced root; do not remove
that guard or attach an old run to bypass it. A report may arrive after completion
while a detached cloud process is still running. In that case use the operator
CLI described below.

The reviewed action adds a support `security_abuse` suspension owned by the case.
It blocks new cost-incurring work, reconnects, root/child attachment and existing
Goal continuations through the shared suspension gates. It cancels the selected
root and recorded children and closes that root's approval session. It does not
change billing holds or restrictions from other sources. A second case cannot
start competing containment for the same account; use the existing case and add
cross-references as necessary.

For cloud runs the server verifies the stored selected workspace and provider
ownership, claims its existing cleanup fence, and terminates that exact sandbox.
Other work sharing that user's workspace is affected. A successful Trigger cancel
is **not** evidence that sandbox processes stopped. Provider absence, Trigger
terminal status, and workspace-fence release are recorded separately. All must be
confirmed before the case is marked contained.

Full cloud snapshots are optional because they include files and memory. Request
one only when needed, recording justification, the responsible reviewer, and a
retention review date. A requested snapshot must be verified and durably recorded
before provider termination. Snapshots can retain detached processes and must not
be restored into a normal user workspace. Any forensic restoration needs separate
authorization and isolated networking.

If requested preservation fails, the workflow still requests Trigger cancellation
but leaves process stop unconfirmed. **Escalate immediately:** retry preservation,
or record why the scoped case evidence is sufficient and explicitly choose
“Stop without full snapshot,” acknowledging possible loss of volatile data.
Never leave this state described as contained or assume the process stopped.

Each operation has a ten-minute case lock, longer than the API's five-minute hard
runtime limit. Read the current case state after an interrupted request.
After the lock expires, retry uses the saved scope and snapshot. Emergency stop also checks the deterministic snapshot name for a capture completed before an interrupted storage response. An unavailable lookup leaves a durable snapshot-review flag; reconcile provider inventory before releasing the evidence hold. A cleanup fence
can be reclaimed only with the same case token, sandbox ID, and region. Never
manually clear an unfamiliar Redis fence. A provider error, changed scope, or
unknown fence requires investigation; keep the restriction active. If final fence
release failed after provider stop, retry completes that exact release before
resolution is allowed.

For local and Desktop runs, cancellation is a request. Verify the actual machine,
including detached child processes and ongoing network activity. Record the
verification method, scope, timestamp, and evidence before choosing the manual
process-stop confirmation. Cloud tests do not establish local or native acceptance.

### Reports received by email, including after a run finishes

`scripts/abuse-response.ts` is the operator entrypoint for a confirmed emailed
report. It works whether or not the reported run is still active. Public intake
cannot reach it. There is no UI. Every call requires service access and an
allowlisted operator. Nothing in the report text selects the account: the operator
supplies identifiers verified from server records, and the backend checks them.

```bash
corepack pnpm exec tsx scripts/abuse-response.ts <import|plan|apply|status|retry> \
  --expect-convex-url <deployment URL> \
  [--expect-trigger-env dev|stg|preview|prod] < case.json
```

- **Credentials** come only from the process environment, loaded from that
  environment's secret store:
  - `NEXT_PUBLIC_CONVEX_URL` must equal `--expect-convex-url` and the URL the
    web/worker use.
  - `CONVEX_SERVICE_ROLE_KEY`. The service client sends a short-lived signed
    proof, never the key, as the RPC argument.
  - `ABUSE_EVIDENCE_KEYS` (`import`, `apply`): the same keyring as Convex.
  - `TRIGGER_SECRET_KEY` (`plan`, `apply`, `retry`): its prefix must match
    `--expect-trigger-env`. Preview also requires `TRIGGER_PREVIEW_BRANCH`;
    `TRIGGER_API_URL` is optional.

  A mismatch stops the command before it reads input or calls any service.

- **Input** is one JSON object on stdin: a pipe, or a file readable only by its
  owner (`chmod 600`). Terminals and group-readable files are refused. Do not put
  case data in arguments or the clipboard.
- **Output** contains receipts and identifiers only. Errors are fixed messages
  with field names, never input values or backend text. Keep output in the
  restricted case record.

1. **Import** the emailed receipt with `operator`, `reference`, `kind`,
   `receivedAt` and a `report` object (`contact`, `target`, `occurredAt`,
   `description`, `sourceIp`, `sourcePort`, `protocol`, `evidence`). Copy only
   the necessary content. Every report field, including source address and
   port, is screened; fields that look like raw credentials are rejected by
   name, without echoing the value. This creates an operator-only case with an
   evidence hold and no restriction. An identical retry returns `existing`;
   changed content conflicts. `intakeReceipt: "found"` means a queue receipt
   for that reference still exists; content is not compared. For an email
   without an `AB-` reference, generate one `AB-<uuid>` once and keep it.
2. **Plan** with `operator`, `reference` and a `subject` object (`userId`,
   `chatId`, `transport`, optional `runId` and `environmentId`). The backend
   checks:
   - the account owns the chat;
   - `environmentId` was recorded for that account and transport (it searches
     the newest 200 connection rows; omit the field for purged environments and
     describe them in the facts);
   - no other case owns containment for the account;
   - any existing `abuse-late:<reference>` restriction is an active support
     security restriction. It is adopted, never duplicated; otherwise the plan
     fails.

   An optional `runId` is checked against Trigger's recorded task, account, chat,
   deployment, transport and environment. It is attribution evidence only and is
   never a cancellation target. Review the printed `planDigest`, restriction
   (`create`/`adopt`) and counts.

3. **Apply** with the plan file plus:
   - `planDigest`;
   - a `requestId` UUID generated once and kept in the file;
   - a `review` object: `reviewer`, `reviewDate`, `retentionReviewDate`,
     `reason`, `verifiedFacts`, and up to five `evidence` items (`source`,
     `observedAt`, `summary`). The reviewer must be an allowlisted operator. The review date cannot be in the future, and the
     retention review date must be later;
   - `acknowledge: {accountRestriction: true, processStopUnconfirmed: true}`.

   One transaction stores encrypted attribution and decision events, then:
   - creates or adopts `abuse-late:<reference>` for that account only;
   - replaces its local token with an unreturned value and blocks token reissue
     and new Desktop sessions;
   - disconnects connected local/Desktop sessions (100 per transaction, the
     remainder on retry). Any Desktop session left connected is refused a
     token refresh or heartbeat and is disconnected at its next attempt;
   - sets the evidence hold and moves the case to `needs_followup`.

   Other restrictions are untouched. If the case revision, status or
   restriction changed after planning, apply fails with `ABUSE_PLAN_CHANGED`. Plan
   again. The command then discovers currently active owned roots and active
   children (queued/running/finalizing) in pages of 25, up to 100 targets. It
   cancels a run only when Trigger's recorded task, owner and deployment match the
   server record. It also closes the root's recorded approval session, even when
   the run is already terminal or the cancel request fails. Each target gets a
   durable receipt: `terminal`, `cancel_requested`, `identity_mismatch` or
   `unknown`. `terminal` is recorded only after Trigger reports a terminal
   status and any approval session is closed; otherwise the target stays
   retryable.

   Trigger calls use strict adapters: no rejection status counts as success,
   unlike the general cleanup helper. Each request attempt has a 15-second
   abortable timeout, with at most two attempts. Before each Trigger
   observation, cancellation or closure, a server checkpoint rechecks the case,
   the active restriction and this operator's lease, then renews the lease.
   The request must be dispatched within one minute of that checkpoint, far
   inside the five-minute lease. An operator whose lease expired, whose
   restriction was lifted, or who was superseded by a retry stops before its
   next Trigger effect.

4. **Status** prints the receipts and an `outstanding` list. **Retry**, or
   rerunning apply with the same file after a lost response, resumes the same
   response after its five-minute lease. It reapplies local invalidation,
   rescans, and retries every non-terminal target. A different `requestId` or
   changed content is rejected.

Limits:

- The response never reports containment. `processStop` is always `unconfirmed`
  and the case stays in follow-up. A Trigger terminal status, a disconnected
  session or a revoked token is not process-stop evidence. Verify local and
  Desktop machines at machine level and record the method as a verified fact.
- `identity_mismatch`, `unknown` and `target_overflow` require investigation. Do
  not cancel guessed runs manually.
- This flow never contacts a sandbox provider (`cloudProvider: not_attempted`).
  For a currently active cloud root, use the verified containment action on the
  same case; the case's own account is allowed. For a historical cloud
  sandbox, inspect the recorded provider/region independently. Verify provider
  ownership and the current workspace selection before any destructive action;
  the old sandbox must not be inferred to be the current one. Preserve the
  minimum evidence first. Terminate only the verified sandbox through the
  authorized provider procedure, recovering only its matching cleanup fence.
  Record provider absence and fence release separately. Escalate unknown
  ownership while the restriction stays active.
- The user cannot issue a new local token or start a Desktop session until every
  reviewed security restriction on the account is lifted. Disconnected clients
  report a regenerated token, the existing reason, so client protocols are
  unchanged. `abuseCases.resolve` releases exactly the recorded case
  restriction, for late-report and containment-only cases alike. It lifts the
  local-access block only when no other active security restriction remains.
  Otherwise, resolving the last remaining security restriction with
  `userSuspensions.resolveBySource` lifts it. Billing and other restrictions do
  not affect the block. The user must then issue a new token. Case resolution is
  refused while a response lease is active. `resolveBySource` refuses an
  `abuse-late:` or `abuse:` source while that case's operator lease is live or
  its containment is in progress. Resolving a case restriction any other way
  stops further leased steps; only `finish` can release the lease.

## Automated egress burst review

With `E2B_EGRESS_ABUSE_REVIEW_ENABLED=true`, a verified attributed egress
burst (see [Cloud network access](cloud-network-access.md#burst-alerts)) can
open an operator case. The review itself is read-only triage. Only the
separately switched [automatic enforcement](#automatic-enforcement) can
restrict an account. The review never contains a run or contacts a sandbox,
and its cases follow the review, hold and erasure rules in this runbook.

- **What it reads.** With a recorded acquisition, only the one chat and
  Trigger run that acquired the burst's verified workspace and whose
  persisted generation time overlaps the burst: the account's stored user
  text and terminal commands with a recorded start receipt. It excludes the contents of command output, interactive terminal
  input, system or hidden text, attachments, and other chats. If the run cannot
  be pinned exactly (several plausible runs, a
  subagent that may have shared the workspace, an unverified workspace, a
  deleted chat, or incomplete records), it opens a manual case without calling
  the model. An incomplete telemetry minute or a replay below the current
  threshold creates no case.
- **Evidence provenance.** Each assistant row records who saved its current
  parts (`terminal_evidence_state`). The Agent worker attests its own run's
  saves: `complete`, or `incomplete` when storage compaction dropped or
  clipped a terminal command or interactive send. Browser snapshots, browser
  saves and crash recovery are `unverified`; adding a run ID or finish
  metadata to an existing row never changes it, and branched or forked chats
  do not copy it. Compaction keeps a terminal command's start only as a
  `terminalStartReceipt` flag beside the unchanged summary, and readers accept
  that flag only on attested rows. The exact-run review and the enforcement
  re-read count any run row that is not attested `complete` as an incomplete
  tool call, so such a run stays a manual case and cannot be blocked or cleared.
  Rows saved before this field existed keep their structured receipts for the
  advisory reassessment and account activity; those reads count `unverified`
  and `incomplete` rows as incomplete too. Deploy Convex before the Agent
  worker so new saves can attest their evidence immediately. If the older
  Convex validator rejects the new field before writing, the worker retries
  once without the attestation so chat persistence can continue.
- **Without an acquisition link.** When the verified workspace has no
  recorded acquisition before the burst, the review still opens a manual case
  and attaches bounded account activity as operator context. Messages do not
  record a workspace, so this mode never names a chat as the cause of the
  burst. It reads the account's chats updated since 24 hours before the burst,
  at most 20 chats and 6 MiB, newest first. For up to three chats, it reads
  the most recent completed Agent run with a recorded terminal start and
  the user turn immediately preceding that run. Hidden, system, and deleted
  content stays outside the review. The worker supplies a short-lived
  attribution proof bound to the verified account, case, and time window in
  addition to the dedicated review credential. After a window's case exists,
  the fallback skips the read. Each run is scrubbed, guarded, and classified on
  its own. A run that meets the same evidence standard as an authorization
  request marks the case `account_activity_concerning`;
  otherwise it stays `no_acquisition_link`. Neither outcome clears the burst
  or produces a draft. Cases created before this mode (record version 1) have
  no account activity; rerunning a review for them does not add it.
- **Bounded account history.** Truncated chat history leaves overlap
  uncertain. The worker allows 20 minutes for Trigger run history to settle,
  then reads up to four pages of 50 account-tagged `agent-long` runs in its own
  environment. It checks run IDs, tags, status and timing with one minute of
  clock skew. If one linked run overlaps and another has unknown timing, the
  worker can rule the other run out when Trigger confirms the same run and
  chat, timestamps consistent with the workspace acquisition, and completion
  before the burst. This requires complete account history and proof for every
  unplaced link. A run that could have overlapped creates a `multiple_runs`
  case, even if its workspace link is missing. A missing selected run, exceeded
  page limit, or unreliable result keeps the case in manual review.
- **Acquisition links.** Each workspace keeps at most 48 link records across
  runs; the review still abstains with `too_many_runs` when more than 16
  distinct runs fall inside its window. Past 48 the oldest records are
  evicted, and the store keeps one metadata member with the newest evicted
  time. A review whose six-hour look-back starts at or before that time reads
  the history as incomplete (`link_history_trimmed`); a later window is
  complete. A run that reconnects repeatedly does not add a record per
  reconnect: an atomic write replaces the run's newest record only while its
  previous record still covers every six-hour look-back window the replaced
  one did, so a record placing a run before a burst survives later
  reconnects. Records are kept for the look-back plus the two-hour telemetry
  retention, so a write between a burst and its review cannot trim a record
  the review needs. Unreadable records or metadata make history incomplete
  (`link_history_invalid`); the next write replaces unreadable metadata with a
  bound at its own time or the newest record, whichever is later.
- **Mixed deployments.** No flag or Redis reset is needed. The previous writer
  kept 16 records plus one trim sentinel and wrote no metadata, so history
  with more than 16 records and no metadata is always incomplete. That
  writer's time prune removes the metadata member; when more than 16 records
  remain, the next current write takes the oldest of them as the bound for
  what that writer evicted.
  The previous reader treats the metadata member as unreadable, so while it
  runs, histories above 16 records report `link_history_invalid` instead of
  `link_history_trimmed`.
- **Diagnostics.** A manual or `no_case` result, and the worker's
  `Egress abuse review finished` log, carry a `diagnostic` object of closed
  enums and small counts: `detail` names why the review stopped (for example
  `multiple_sandboxes`, `link_history_trimmed`, `too_many_runs`,
  `competing_links`, `concurrent_root_run`, `root_page_limit`,
  `root_lookup_failed`, `selected_run_absent`, `run_overlap_unknown` or
  `evidence_gaps` with its `gaps` list), alongside counts of verified
  sandboxes, stored link records, linked runs and plausible runs.
  `competingLinksRuledOut` counts unplaced links the Trigger check ruled out
  before the evidence read. These diagnostics contain closed values and counts.
- **Account cooldown.** A `no_case` decision, which requires complete
  exact-run evidence and corroborated legitimate work, stores a 24-hour
  cooldown for the verified account with the cleared minute's connection
  count. Owner references differ per region, so the cooldown is keyed by a
  hash of the verified account and applies in every region. While it lasts, a
  burst of that account is a routine spike and is skipped before evidence
  reads and model calls (`skipped` / `cooldown_active`, no case or receipt)
  unless the window's highest settled minute reaches both twice the cleared
  count and twice the current threshold; such an escalation is reviewed in
  full, because a new run can still be abusive. Manual cases, authorization
  requests, enforcement and incomplete or unlinked evidence never grant it. A
  later clearance at a higher count replaces it with a new 24-hour expiry;
  an equal or lower one leaves it unchanged, and a retry of the granting
  window is never suppressed. The monitor checks the cooldown only for new
  cases it is about to queue and leaves a suppressed case unmarked, so a later
  escalation in the same window is still queued. A worker that already holds
  the window's queue key waits for the window to settle before skipping it.
  It reviews the highest verified spike if the cooldown is bypassed. If it
  runs out of retries it reviews the evidence. Any read failure, invalid stored
  value, or missing or lossy minute in the window means a full review; a failed write
  leaves no cooldown. To end cooldowns early, delete the
  `egress-review:v1:cooldown:*` keys; they otherwise expire on their own.
- **What it decides.** The model receives scrubbed evidence and returns
  enums and evidence indices. Hostnames, dotted names with alphabetic
  suffixes, and IPs become stable class placeholders. The scrubber normalizes
  IPv6 spellings and gives CIDR ranges their own identifiers. To clear
  in-scope testing, the cited messages must name or provably cover every
  public or potentially public command target. A draft requires complete
  context and cited concerning commands against a known public target. A
  claimed scope mismatch also requires a target outside the scope supported
  by the read history. Inconclusive evidence goes to manual review.
- **What it stores.** One case per owner reference, region and 30-minute UTC
  window, encrypted with the abuse evidence keyring: fixed rationale text, the
  evidence mode (`exact_run`, `account_activity` or `none`), the
  classification enums, coverage, the verified account, chat and run
  identifiers, and locators for the cited messages and tool calls. Account
  activity is stored per chat with its finding, coverage and locators. It never
  stores prompts, commands, user text, or model output. Later bursts in the
  same window preserve the encrypted case and any operator review. A repeat
  write returns a `preserved` receipt. If a later review clears the activity,
  its `no_case` result describes that attempt and the stored case is preserved.
  The case starts as `new` without an evidence hold.
- **The draft.** It is from `abuse@hackerai.co` and asks for the targets, the
  permitted activity, the date and time scope, and redacted proof. It names the
  verified account ID, not an address: resolve the account's verified contact
  during review, confirm the facts from the cited messages and tool calls, and
  send it yourself only if appropriate. A connection count does not show which
  command, if any, caused the connections.

The review uses `CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY` in the Agent worker and
Convex. Generate it independently of the general and research service keys.
It authorizes only the `egressAbuseReview` functions, which can
create or preserve a review case but cannot create notices or restrictions,
and the one [reassessment](#reassessing-a-retained-candidate) action.
The Agent worker and Convex deployment must share the same
`CONVEX_SERVICE_ROLE_KEY` for signing and verifying the account-activity
attribution proof. This key must differ from the dedicated review key. A
missing or mismatched key leaves account activity unavailable in the manual
case. The worker also needs `ABUSE_EVIDENCE_KEYS` and the existing research
model configuration.

Deploy the Convex query before releasing the updated Agent worker. If the
worker reaches Convex before the query is available, it preserves the warning
as a manual case without account evidence. Later attempts preserve that case.
Enable the toggle in the web app, the Agent worker, and the Convex deployment.
Reviews are dispatched through the persistent queue described under
[Burst alerts](cloud-network-access.md#burst-alerts).

New cases and their sanitized `egress_review_receipts` commit together. A
completed review with no case writes its receipt on a best-effort basis.
Retries preserve existing cases and receipts, and cases created by older
workers can lack a receipt. Receipts last 30 days and store the enforcement
decision (`keep_active`, `block_applied` or `enforcement_pending`), a closed
reason, the evidence mode and coverage state. Only `enforcement_pending` and
`block_applied` receipts carry the case reference.

To roll back reviews, set `E2B_EGRESS_ABUSE_REVIEW_ENABLED=false` in the web
app, the Agent worker, and the Convex deployment. This is separate from burst
alerts, which keep their own toggle and continue unchanged. Acquisition links
and queued reviews expire on their own, and existing cases stay available to
operators.

The alert schedule runs only in Production. In Preview, confirm both regional
telemetry heartbeats. Upload synthetic traffic above the Preview threshold for
a pilot workspace with a linked Agent run. Trigger `egress-burst-alerts` manually
with a `timestamp` two minutes after the synthetic minute. Confirm the monitor
logs a `High connection volume` warning and the delayed `egress-abuse-review`
returns a `completed` or `preserved` receipt after the run history has settled.

### Run timeline shadow

`E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED=true`, together with the review
toggle, keeps a second, diagnostic-only index of which runs acquired each
verified workspace. Set it in the web app and the Agent worker; it is off by
default and needs no Convex change. It never feeds a decision, case, receipt,
cooldown, notice or restriction, and never calls the model.

- **What it records.** At the same verified acquisition boundary as the
  acquisition links, one record per run of a workspace: the first and the
  latest acquisition. Reconnects move only that run's latest time, so a busy
  run cannot crowd out another. A workspace keeps at most 32 runs; past that
  the least recently acquiring run is evicted and the newest evicted time is
  kept. Records follow the acquisition-link retention. Acquisitions do not
  wait for the write. The review reads in parallel and may wait for diagnostics
  at the end of the attempt, within the 1.5-second read budget.
- **What it lists.** For each verified workspace of a burst (at most four),
  the runs first acquired before the burst ended and acquired again no
  earlier than six hours before it began. Proxy telemetry identifies a
  workspace, not a run, so a listed run could have used the workspace; it is
  never named as the cause. Acquisition times alone do not establish continuous
  activity, and the best-effort index can miss an acquisition. The assessment
  describes recorded candidates only and is `none`, `one_possible`,
  `several` (parents and subagents are counted separately), `incomplete` or
  `unavailable`. `incomplete` carries closed limitations
  (`evicted_in_window`, `invalid_record`, `capped`, `workspaces_capped`,
  `workspace_unavailable`), and its counts are lower bounds. A run that was
  evicted and acquired again starts a new record, so a later first-time
  record near an eviction also marks the window `evicted_in_window`.
- **What it cannot see.** Tool calls on an already connected client, lease
  heartbeats, run completion or cancellation, and processes left running
  after a run ended are not observed. A run whose acquisitions are more than
  the retention apart, or that stopped acquiring more than six hours before
  the burst while still running, is not listed. Acquisitions without a server
  chat and Trigger run, such as some Ask requests, are not recorded.
- **Where to view it.** Each settled review attempt that read the timeline
  writes one `Egress run timeline shadow` log in the Agent worker: the
  timeline summary, the review's status, reason, `detail`, `runLinks` and
  `plausibleRuns`, and whether the run the review selected is listed. It holds
  no identifiers, prompts, commands or payloads. Compare outcomes in aggregate
  across Trigger logs; a single line is not evidence about an account.

To validate in Preview, enable both toggles in the Preview web app and worker,
acquire a pilot workspace from an Agent run, and follow the burst procedure
above. Confirm the review's receipt is unchanged and the worker log shows the
shadow line with `selectedRun: "listed"`. To stop it, unset the shadow toggle in
both processes; its keys (`egress-review:timeline:v1:*`) expire on their own
and nothing else reads them.

### Reassessing a retained candidate

A `multiple_runs` or `account_runs_unverified` case can record the one linked
candidate chat and run but read none of its evidence, because another run may
have shared the workspace or the account's other runs could not be ruled out
(for example, Trigger history beyond the page limit). The record does not say
which check failed. Rerunning `egress-abuse-review` does not help: the
telemetry it re-verifies expires after two hours, and the existing case is
preserved.
To get advisory context on that candidate, trigger `egress-abuse-reassess`
manually with only the case reference:

```json
{ "reference": "AB-…" }
```

It is never scheduled or queued automatically. It needs the review toggle,
`CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY`, `ABUSE_EVIDENCE_KEYS` and the
research model configuration, and makes one attempt; rerun it if needed.
Deploy the Convex functions before the worker; until then the task fails
without reading anything.

- **Which cases.** An open (`new` or `reviewing`), uncontained, unerased case
  created by the automated review (its `received` event actor is
  `egress_abuse_review`) within the last seven days. The decrypted record must
  be a version 3 `manual_review` record with reason `multiple_runs` or
  `account_runs_unverified`, no evidence read, a verified account, exactly
  one counted workspace, a positive connection count, a consistent burst
  minute and window, and a region, owner reference and
  window that hash to the case's reference and stored digest. Anything else
  returns `closed` with `case_unavailable`, `source_mismatch`,
  `record_invalid`, `not_overlap_case` or `no_candidate` (a case such as
  `competing_links` that kept no candidate), and reads no chat.
- **What it reads.** Only the retained candidate run, through the same
  bounded exact-run read as the review: ownership, the deletion fence, the
  run's persisted timing overlapping the burst, subagent overlap, size
  limits and content exclusion all apply. It omits only the account-wide
  check for other active root runs and does not list Trigger run history, so
  neither the marker nor the history check that caused the original
  abstention blocks the read. Each invocation adds one `read` event
  with actor `egress_abuse_reassessment`. Convex rechecks that the case is
  unchanged before reading the run; a case resolved or erased in between
  returns `closed` / `case_changed`. Before classification, the worker also
  verifies that Trigger recorded the candidate as completed before the read
  started, allowing one minute for clock skew. It requests only the run ID,
  task, status, and completion timestamp from Trigger. An unverified
  completion returns `incomplete` / `candidate_completion_unverified`.
- **What it returns.** Closed enums only, never identifiers or content.
  `scope: retained_candidate_only`, `attribution: unverified` and
  `otherCandidates: unverified` mean that the other runs and which activity
  caused the burst were not checked. `coverage` is `complete`, `incomplete`
  (with `gaps`) or `unavailable` (with `reason` `candidate_unavailable`,
  `run_mismatch`, `evidence_incomplete` or `subagent_overlap`). Complete
  evidence is scrubbed, guarded and classified like the review, and the
  `advisory` is `neutral` (the `no_case` standard held), `concern` (the
  authorization request standard held) or `inconclusive`. Incomplete
  evidence is never classified. `classification` (activity and
  authorization) appears only with `neutral` or `concern`.
- **What it means.** `determination: advisory_only`: the finding describes
  the candidate run, not the burst. It does not resolve, annotate or change
  the case or its decision, block or unblock the account, grant a cooldown,
  draft or send mail, or write a receipt. Record any conclusion in the case
  yourself after reviewing the chat and run the case records.

### Automatic enforcement

A block requires every one of these, in order. Anything else keeps the account
active with a reason of `legitimate_corroborated`, `coverage_incomplete`,
`inconclusive`, `intent_not_established` or `unlinked_history`.

1. The exact, server-attributed run, read completely: finished, no subagent or
   concurrent root, no truncation or omission, at least one user message.
   Unlinked account activity never blocks.
2. The existing policy's concerning, unauthorized finding with cited commands
   against a public target.
3. A separate structured confirmation over the same scrubbed evidence: an
   explicit, first-person statement of harm (service disruption, unauthorized
   access, credential or data theft, extortion), no claimed or unclear
   authorization, citing the stating message, the command and the target.
   The worker checks that the target is public, named in the cited message,
   and acted on by every cited command, and that the first pass cited the
   same commands. Each cited message must already have existed in its
   current form before the run started. Scanning, volume, tool names, missing
   or mismatched scope,
   claimed impact and model confidence never establish intent.
4. The Convex mutation `egressAbuseEnforcement:applyBlock` rechecks the burst
   age (at most 24 hours), account, chat ownership, deletion fence, finished
   run and subagents, and every cited message and started tool call. A proof
   from the review worker binds the decision to this deployment and these
   exact inputs. Convex re-reads the bounded evidence and checks its
   fingerprint before applying a block. The mutation
   refuses any existing case for the window, including manual, resolved or
   erased ones, so it never acts retroactively.

One transaction then creates the case (`needs_followup`, evidence hold),
adds `abuse-late:<reference>` as a support `security_abuse` restriction,
revokes local and Desktop access, records an `abuse_responses` row with actor
`egress_abuse_enforcement`, and queues one notice. It cancels no run and never
reports any process as stopped. A lost response is safe: the retry returns
`existing_block`. A refusal or unavailable backend records the case as
`enforcement_pending` for an operator instead.

**Switches.** Defaults are off. `E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED=true`
is required in the Agent worker and in Convex, in addition to the review
switch. Setting it to anything else in Convex stops new blocks immediately;
reviews and cases continue, recording `enforcement_pending`. Existing blocks
and queued notices are unaffected. `ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED=true`
in Convex lets the dispatcher claim notices; without it notices queue and the
summary lists them as backlog.

**Credentials.** Each is distinct from every other service key and scoped to
one module by `convex/lib/serviceFunctions.ts`:

- `CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY` (Agent worker and Convex):
  only `egressAbuseEnforcement` functions.
- `CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY` (local dispatcher and Convex):
  only `abuseBlockNotices` functions: claim, acknowledge and the aggregate
  summary.

Service proofs bind the deployment URL; a proof for another deployment fails.

**Notices.** The dispatcher runs on the abuse mailbox host:

```bash
corepack pnpm exec tsx scripts/abuse-block-notices.ts dispatch \
  --expect-convex-url <deployment URL> --expect-workos-env test|live
corepack pnpm exec tsx scripts/abuse-block-notices.ts summary \
  --expect-convex-url <deployment URL>
```

`NEXT_PUBLIC_CONVEX_URL` must equal the asserted URL. Test dispatch uses
the approved staging key. For live dispatch, verify the WorkOS key against
the intended Production directory. Derive a 32-byte scrypt pin from the
exact verified key and a random 16-byte salt using `N=32768`, `r=8` and
`p=1`. Set `ABUSE_NOTICE_WORKOS_KEY_PIN` to the lowercase hex salt and pin
separated by a colon. WorkOS keys can use the opaque `sk_` format. An
invalid pin or a staging key fails the live assertion before any claim.
`dispatch` also needs `ABUSE_NOTICE_BRIDGE_DIR`, the absolute
directory of the pinned Proton Bridge
helper exposing `imap_session()` and `smtp_session()`, and optionally `ABUSE_NOTICE_PYTHON` and
`ABUSE_NOTICE_MAIL_HELPER`. The Bridge session must be able to send as
`abuse@hackerai.co`.

A claim succeeds only while the notice's own restriction is active and its
case is open; a notice for a lifted block is cancelled. The dispatcher reads
the exact account from WorkOS and sends only to its verified address. It runs
`scripts/abuse-notices/send_block_notice.py` with `python3 -I -B`, no
inherited environment, and one JSON object on stdin (`version`, `messageId`,
`from`, `to`, `subject`, `text`). The helper prints one JSON object,
`{"result": "sent" | "not_sent" | "rejected" | "uncertain"}`, and never the
address. The helper checks Sent for the exact Message-ID, sender, recipient and text
before and after SMTP. SMTP acceptance without a matching Sent copy, a
crash, timeout or malformed output counts as `uncertain`. The fixed
notice names the reference and the appeal route and contains no evidence.

Notice states: `pending`, `sending` (five-minute lease), `sent`, `uncertain`,
`failed` (`rejected`, `recipient_unavailable`, `attempts_exhausted`),
`cancelled` and `deduplicated` (another live notice already covers the
account). Only `not_sent` retries automatically, at most five attempts with
backoff. An expired lease or `uncertain` result is never resent.

**Summary.** `summary` prints switches, 24-hour review counts by decision,
reason and coverage, active and lifted automated blocks from the last 30
days, notice counts, and action items with only a reference:
`review_block` (no operator note since the block), `review_pending_enforcement`,
`notice_backlog`, `notice_failed` and `reconcile_uncertain_notice`.

**Recovery.**

- Restore access: resolve the case with `abuseCases.resolve` as for any
  late-report case. It releases exactly the case restriction and lifts the
  local-access block when no other security restriction remains. The user
  issues a new local token. Pending notices are then cancelled.
- Active work: an automated block does not cancel runs. To cancel active
  owned work, run `scripts/abuse-response.ts retry` on the case; it resumes
  the recorded response.
- For an uncertain notice, reconcile its exact Message-ID in the abuse@ Sent
  folder. Use the internal `abuseBlockNotices:resolveNotice` from the
  authorized dashboard with the notice ID, current status and attempts. Use
  `confirmed_sent` after finding the matching Sent copy. Before recording
  `confirmed_not_sent`, disable new claims, stop all dispatchers and mail
  helpers for this deployment, and verify that every in-flight SMTP submission
  has settled. A disabled switch or an expired lease leaves any open SMTP
  submission running. Recheck Sent after the drain and confirm that Proton
  did not accept the message. Keep the notice uncertain if acceptance is
  unresolved. Once reconciliation is complete, restore the previous claims
  switch and dispatcher service state. If dispatch was active before the
  drain, restart the dispatchers and verify that they can claim work.
  A failed notice accepts `retry` while the block is active or `dismiss`
  after another contact method. Attempts are never reset.
- Rollback: turn off the enforcement switch first, then dispatch. Keep the
  schema, tables and handlers deployed while any automated case, restriction
  or notice exists.

Verify in Preview with synthetic placeholder content only: a confirmed block,
each refusal, duplicate retry, a lifted block's cancelled notice, an
uncertain send and its reconciliation, and the summary while dispatch is off.

## Resolution and evidence lifecycle

Resolve with a recorded reason. An exonerated case can restore its verified original workspace selection without killing the sandbox; the exact case fence is rolled back and process-stop status remains separate. A changed or unfamiliar workspace stays restricted until investigated. Resolution releases only the case-owned security
restriction, leaves independent restrictions intact, and does not restore a
snapshot. The evidence hold remains on until a separate reviewed release.

There is no automatic evidence deletion or fixed public retention promise. Before
real-report enablement, record the following table in the owning internal issue.
Each row requires an accountable owner, an explicit review interval, an explicit
deletion period and its starting event, and a verification method. Do not replace
these with an undefined “periodic” review. Distinguish proposed periods from the
owner-approved policy; this runbook does not adopt or invent legally mandated
periods.

| Evidence class                             | Required policy decision                                                                 | Deletion verification                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Report content and contact details         | Review interval; deletion period measured from the chosen closure event; owner           | Case ciphertext absent after all deletion batches                     |
| Review notes and copied evidence           | Review interval; deletion period and starting event; owner                               | Note ciphertext absent, including historical pages                    |
| Audit metadata and containment identifiers | Separate review and deletion periods; justified need for continued identification; owner | Authorized backend audit verifies the specific metadata scope removed |
| Provider snapshots                         | Necessity review interval; explicit deletion deadline/starting event; owner              | Provider readback confirms the exact snapshot is absent               |

Lawful preservation requirements and active case holds override scheduled deletion;
record the basis, scope, owner and next review date without placing privileged
advice in public records. A reviewer must check that basis before releasing a hold.
The metadata row requires a separately authorized backend procedure because
`abuseCases.eraseEvidence` intentionally retains audit metadata. Do not describe
it as full account erasure. Track due reviews and deletions in the internal case
record, including completed work or a justified hold extension. After resolution
and reviewed hold release, the authorized service client can call
`abuseCases.eraseEvidence` with the current revision and full reference as
confirmation. Deletion runs in bounded batches; read the updated revision and
repeat while the backend reports more remain.
Audit metadata and containment identifiers remain. Provider snapshots are separate:
review the exact case/sandbox/region association, obtain the appropriate deletion
authorization, delete only that snapshot, verify provider absence, and record the
outcome before deleting the case notes. Releasing a hold by itself deletes nothing.

The historical case backend remains available only through authorized service
access. Its operator allowlist, audit trail, holds and containment guards remain
in force; new email submissions never invoke these actions.
