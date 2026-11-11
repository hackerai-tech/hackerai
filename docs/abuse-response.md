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
    `--expect-trigger-env`.

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
   the necessary content; fields that look like raw credentials are rejected. This creates an operator-only case with an
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
  restriction. It lifts the local-access block only when no other active
  security restriction remains. Otherwise, resolving the last remaining
  security restriction with `userSuspensions.resolveBySource` lifts it. Billing
  and other restrictions do not affect the block. The user must then issue a
  new token. Resolution is refused while a response lease is active.

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
