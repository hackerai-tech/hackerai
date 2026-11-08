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
- Web: set `ABUSE_EMAIL_VERIFIED=true` only after separately verifying mailbox
  delivery and monitoring. Otherwise the page does not display the email address.

The operator page requires a WorkOS session; the API checks both that identity and
same-origin requests. Convex requires the existing signed service proof and the
operator allowlist. Every evidence read and action creates an audit event.
Do not share session cookies, service credentials, or evidence keys with reviewers.
Case evidence is encrypted before RPC so validation errors cannot echo report text.
The reporting and operator routes suppress PostHog events and Intercom startup.

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
Verify unauthorized operator rejection and audited evidence access. For containment,
exercise a root with a child and a detached process; prove selected-process stop,
independent-user continuity, blocked restart/reconnect/Goal continuation, partial
provider failure, retry after interruption, and resolution with an independent
billing hold still active. Preserve separate evidence for web, cloud, local, and
native Desktop paths; never infer one from another.
