# Finding projects and report exports

A finding belongs to its source chat. Its project index follows that chat's
current project. Moving a task or deleting a project schedules bounded membership
updates; the project query checks current chat membership while those updates
finish, so old-project results are hidden immediately. Deleting a project keeps
the findings available globally. Existing chat/account deletion still removes
its findings.

After deploying this schema to an explicitly verified environment, run
`findings:backfillFindingProjects` with `{"cursor":null}` using that environment's
explicit deployment selector **before enabling project navigation**. The internal
mutation processes bounded pages and schedules continuations. Wait for those
jobs to finish and verify existing findings in both the global and project views.
Never select a deployment from its `dev` or `prod` label alone. Local and Preview
acceptance do not authorize running this migration in Production.

Evidence basis is an Agent-reported assessment, separate from severity,
confidence and active/closed lifecycle. Source review, runtime reproduction and
inconclusive are explicit saved fields with a factual reason. Older records stay
"Not recorded". File-reference availability never upgrades the evidence basis.
Corrections that change the target, analysis, PoC or evidence clear an earlier
label unless the Agent supplies a fresh status and reason together. Retesting
prepares an editable request in the original chat; it neither starts work nor
closes a finding automatically and preserves existing drafts.

Selected exports retrieve each exact, authorized saved record. Missing records
fail the whole export. Reports are limited to 50 findings and 8 MiB of structured
input; the limits reject rather than truncate. They describe selected findings,
not full assessment coverage. Markdown, HTML, JSON, SARIF and PDF retain evidence,
limitations, correction/closure context and source provenance. These private
exports can include PoCs and captures; public shared-chat projections remain
separate.

HTML is self-contained, escaped and has no active report links, images or scripts.
SARIF keeps evidence basis, lifecycle and the complete record in result properties;
none of those fields is emitted as a SARIF verification pass. PDF embeds a local
OFL-licensed Noto Sans font and attaches the exact JSON record. Characters outside
that font are visibly represented as Unicode code points, with a font note; the
attachment retains the original Unicode and unwrapped captures.

Text exports keep the existing native save command. PDF uses a distinct binary
save command and the same atomic replacement writer. Older Desktop shells fail
with an update instruction instead of writing base64 or corrupting the PDF.
Browser download initiation, confirmed native save, cancellation and failure are
separate telemetry outcomes. No export starts a model request or sandbox.
