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
  old keys while queued payloads and receipt retries depend on them. Update both
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
required only by the authorized historical-case backend described below.

## Security check and receipts

The web API validates report fields and Cloudflare Siteverify before enqueueing,
requiring the configured hostname and `abuse_report` action. Missing, expired,
reused or mismatched tokens fail closed, including a seven-second provider timeout.
Tokens never enter encrypted payloads, fingerprints or analytics; report contents
are not sent to Siteverify. The intake and former operator routes suppress product
analytics and Intercom startup.

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

On SMTP acceptance, the finish transaction immediately removes the queued report
ciphertext. Only reference, digest, timestamps, delivery status and attempt count
remain. Unsent encrypted payloads expire after seven days; minimal receipts expire
after 30 days. A bounded five-minute maintenance sweep deletes expired data even
while SMTP is disabled. Active sends retain their payload until their two-minute
lease expires. Rate-limit hashes expire separately after their short window.
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

1. Open the queue or a full `AB-…` reference. Treat submitted fields as allegations.
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
while a detached cloud process is still running. In that case use the late-report
procedure below.

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
runtime limit. Reload after an interrupted request and inspect the saved state.
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

### Reports received after a run finishes

This path requires an authorized operator with service access; it is not exposed
as an automatic case action. Keep the case in review or follow-up until the
separate restriction and runtime checks are recorded.

1. Record a verified-fact note tying the report to the historical root, account,
   chat, provider sandbox and region, and a decision naming the reviewer and
   reason for restriction. Recheck the current workspace selection; the old run's
   sandbox must not be inferred to be the user's current sandbox.
2. Using the existing signed `userSuspensions.upsertActive` mutation, set only
   that verified user's `support` / `security_abuse` restriction with a unique
   case-specific source ID such as `abuse-late:<full AB reference>`. Record the
   exact source ID and read back the active restriction in the case. Preserve all
   other sources. This blocks new work; it does not prove existing processes stop.
3. Independently inspect the historical sandbox at the recorded provider/region.
   Verify its provider ownership and the current workspace state before any
   destructive action. Preserve the minimum necessary evidence first. If it still
   exists, terminate only the verified sandbox through the authorized provider
   procedure, preserving or recovering only its matching workspace cleanup fence.
   Do not clear an unfamiliar fence or terminate a replacement workspace by guess.
   Unknown ownership or selection requires escalation while the restriction stays
   active. Cancel any separately verified active root/children in that workspace.
4. Record provider absence, Trigger terminal state, and any workspace-fence
   release separately, with timestamps and the verification method. For a local
   or Desktop process, require machine-level verification. A restriction or a
   completed historical run alone is never process-stop evidence.
5. After appeal or resolution review, use `userSuspensions.resolveBySource` only
   with the exact recorded user and `abuse-late:` source ID. Verify the selected
   restriction is resolved and independent restrictions remain active, then
   record the result before resolving the case. The case's normal Resolve action
   does not remove this separately recorded late-report restriction.

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
The metadata row requires a separately authorized backend procedure because the
case-evidence button intentionally retains audit metadata. Do not describe that
button as full account erasure. Track every due review and deletion in the internal
case workflow and record completion or a justified hold extension.
After resolution and
hold release, an operator can delete report and note contents by typing the full
reference. Deletion runs in bounded batches; repeat while the backend reports more remain.
Audit metadata and containment identifiers remain. Provider snapshots are separate:
review the exact case/sandbox/region association, obtain the appropriate deletion
authorization, delete only that snapshot, verify provider absence, and record the
outcome before deleting the case notes. Releasing a hold by itself deletes nothing.

The historical case backend remains available only through authorized service
access. Its operator allowlist, audit trail, holds and containment guards remain
in force; new email submissions never invoke these actions.
