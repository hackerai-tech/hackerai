# Abuse reports and scoped containment

`/abuse` accepts signed-out reports and appeals. `/abuse/operations` is a restricted
review workflow. A report never automatically changes an account. Submitted links
remain plain text and are not fetched by the intake or review page.

## Configuration and access

Enable only after a named operator owns intake review, escalation, and preservation
review. Record those assignments and review dates in the owning internal issue.
Before enabling intake for real reports, the owner must approve and record the retention policy described below. Proposed periods are not an adopted policy. Configure each environment independently:

- Web: `ABUSE_EVIDENCE_KEYS`, a JSON keyring with `active` key ID and `keys` mapping
  key IDs to 32-byte hexadecimal keys. Keep keys in the environment secret store.
  Retain old keys while evidence or idempotent retries still depend on them.
- Web and Convex: `ABUSE_OPERATOR_USER_IDS`, an explicit comma-separated allowlist
  of immutable WorkOS user IDs. Ordinary support membership grants no access.
- Web and Convex: `ABUSE_INTAKE_ENABLED=true`. Missing configuration fails closed.
- Web: `ABUSE_TURNSTILE_SITE_KEY`, `ABUSE_TURNSTILE_SECRET_KEY`, and
  `ABUSE_TURNSTILE_HOSTNAMES` (comma-separated exact hostnames, without schemes or
  paths). Use a dedicated Cloudflare **Managed** widget with matching hostnames
  and no pre-clearance. Keep Preview and Production widgets and secrets separate;
  a Preview hostname must not enable the Production form. Published dummy keys
  are rejected. These web settings require a new deployment; they are not needed
  by Convex or Trigger workers.
- Web: set `ABUSE_EMAIL_VERIFIED=true` only after separately verifying mailbox
  delivery and monitoring. Otherwise the page does not display the email address.

The operator page requires a WorkOS session; the API checks both that identity and
same-origin requests. Convex requires the existing signed service proof and the
operator allowlist. Every evidence read and action creates an audit event.
Do not share session cookies, service credentials, or evidence keys with reviewers.
Case evidence is encrypted before RPC so validation errors cannot echo report text.
The reporting and operator routes suppress PostHog events and Intercom startup.

### Security check and submission retries

The public form loads Cloudflare Turnstile. The API validates every challenge with
Siteverify before writing a case, requiring both the configured request hostname
and the `abuse_report` action. Missing, expired, previously redeemed, or mismatched
tokens cannot save a report. Verification has a seven-second timeout and fails
closed on provider/network errors. Tokens are bounded to 2,048 characters and are
sent separately from the bounded report body; they never enter stored evidence,
idempotency fingerprints, logs, or analytics. No report fields are sent to Siteverify.

Cloudflare tokens expire after five minutes and can be redeemed only once. The
widget refreshes expired challenges; the form also renews an old challenge before
submission and creates a fresh check after every request attempt. Script failures
offer an in-place retry. All these paths preserve report fields. A lost response
can be retried with the same report submission ID and a new challenge; the durable
intake returns the original receipt instead of creating a duplicate. Only a saved
case reference confirms receipt. See Cloudflare's
[server-side validation contract](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

Do not disable verification to work around a provider outage. Keep the form's
unavailable/retry messaging and existing Help Center route available. Activating a
verified mailbox remains a separate operational decision.

## Review and attribution

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
reference. Deletion runs in bounded batches; repeat while the UI says more remain.
Audit metadata and containment identifiers remain. Provider snapshots are separate:
review the exact case/sandbox/region association, obtain the appropriate deletion
authorization, delete only that snapshot, verify provider absence, and record the
outcome before deleting the case notes. Releasing a hold by itself deletes nothing.

## Acceptance

Use synthetic reports and disposable, explicitly owned runtimes. Verify anonymous
and expired-session intake, invalid fields, storage failure without a false receipt,
retry idempotency including retained-key rotation, and desktop/narrow layouts.
For Turnstile, check a real Managed widget on the exact Preview hostname, script
failure and retry with fields retained, slow composition/expiry, rejected tokens,
and a lost-response retry using a renewed challenge and the same case reference.
Verify unauthorized operator rejection and audited evidence access. For containment,
exercise a root with a child and a detached process; prove selected-process stop,
independent-user continuity, blocked restart/reconnect/Goal continuation, partial
provider failure, retry after interruption, and resolution with an independent
billing hold still active. Preserve separate evidence for web, cloud, local, and
native Desktop paths; never infer one from another.

## Email notifications

The case receipt confirms durable storage, independently of email delivery. On the
Convex deployment, configure only a dedicated `ABUSE_SMTP_PASSWORD` token paired
with `abuse@hackerai.co` and `ABUSE_NOTIFICATION_REVIEW_URL` as the exact HTTPS
web origin for that environment. For HackerAI Production use `https://hackerai.co`;
for Preview use the verified branch origin. Self-hosted implementations can use
their own HTTPS origin. Credentials, paths, queries and fragments are rejected.
Verify the exact origin against the web deployment before saving configuration.
These two variables belong only in Convex, not Vercel or Trigger. A present,
nonempty SMTP token enables notifications; remove it to pause delivery.
Use separate SMTP tokens for Preview and Production. Do not use a mailbox login
password. SMTP submission uses Proton's fixed host and port with mandatory
STARTTLS and certificate verification. No sender, recipient, or SMTP endpoint is
accepted from a report.

The initial case transaction creates one outbox row and schedules delivery;
receipt retries do not enqueue duplicates. Notifications contain only the case
reference and restricted operator-page link, without report text, evidence,
contact email, or submitted targets. Email recipients still need operator access.

Inspect `abuse_notifications` in the authorized Convex dashboard, using its status
index. `sent` means Proton accepted the message, not that inbox delivery was
independently verified. Reconcile `failed` and `uncertain` entries during intake
review. Explicit transient SMTP rejection and preflight connection errors retry
up to five attempts with increasing delays. Permanent rejection/configuration
failure remains `failed`. Removing the SMTP token pauses existing queued work;
a five-minute sweep resumes it after the token is restored. The sweep also recovers
stale pending work whose scheduled action never claimed it, waiting beyond the
64-minute maximum retry delay plus five minutes. Recovery uses a bounded index
query and the same single-claim protection. New reports received without an SMTP
token do not queue notifications, including subsequent receipt retries after a
token is added. Lost acknowledgements after DATA and expired send leases become `uncertain`; these are not blindly retried because SMTP has no
exactly-once delivery guarantee. A stable Message-ID assists reconciliation.
Before any manually authorized resend, check the recipient inbox and Proton Sent
folder for the case reference and record the decision in the internal case record.
Do not mutate an unfamiliar outbox entry to work around delivery uncertainty.
After correcting configuration, an authorized backend administrator can run the
internal `abuseNotifications:retryFailed` mutation with the exact `notificationId`
and its current `expectedAttempts`. It accepts only confirmed `failed` entries
with retained case evidence and enabled notifications; pending, sent, changed, or
uncertain entries are rejected. It preserves the attempt count and stable message
identity. The existing automatic-attempt budget is not reset; after exhaustion
this permits one explicit send attempt. Verify the result and record recovery
in the internal case workflow.

Before enabling real notifications, submit a synthetic report through the actual
web form and independently confirm the matching reference in the intended inbox.
Verify receipt retries keep one outbox entry, and test transient failure and
uncertain-send behavior. Confirm mailbox ownership and monitoring separately;
SMTP acceptance alone does not establish either. `ABUSE_EMAIL_VERIFIED` only
controls the public email link and does not activate notifications.
