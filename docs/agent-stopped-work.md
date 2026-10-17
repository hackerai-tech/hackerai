# Persistent Agent stop instructions

Visible authenticated Agent user messages are registered for review in the same
Convex transaction that saves the message. Hidden automatic continuations,
regeneration, assistant messages and child `parent_update` messages cannot create
or reopen restrictions. A pending source cannot be overwritten: retry that turn
before submitting a different instruction. This preserves instructions if a worker
fails before extraction.

Before its first acting model call, the parent reviews that immutable source with
a separate structured-output model. The service mutation checks source text,
verbatim quote, ownership, revision and linked task IDs, then saves the directives
and cancels explicitly linked queued/running workers transactionally. Model
interpretation of intent and task matching remains probabilistic. Reopening needs
a newer explicit user source; generic continuation does not reopen work. Reopening
a restriction never restarts an already cancelled worker automatically.

Private chat fields hold the bounded history (32 directives, 128,000 serialized
characters) and source snapshot. Directives retain message IDs and verbatim quotes;
full source text is stored once in the current source snapshot, not copied into
every directive. Historical sourceText fields remain readable for compatibility.
Capacity errors preserve existing restrictions and the pending instruction. The
user can recover in the same chat by sending exactly: `Reopen all stopped work
and clear this chat's stop history.` Only the authenticated visible user source
can perform this reset; it clears every saved exclusion and the pending
instruction, advances the revision, and records the reset's message ID/text.
Cancelled workers are not restarted. Quoted text, hidden messages, generic
continuation and actor tools cannot reset the history. Long messages receive an
actionable 24,000-character validation error directing logs to file attachments.
Pending-review failures instruct the user to retry the saved turn after any usage
limit or outage clears. These errors survive both HTTP and durable-stream error
serialization rather than appearing as generic database/provider failures.
Deleting the chat or account deletes these fields with their owning chat. Public
chat serializers omit them. A branch/new chat does not inherit them. Cross-chat
engagement binding is not implemented.

Parent and child prompts receive effective restrictions outside transcript
compaction. Each tool execution reads current state; when restrictions exist, a
separate semantic review must positively allow the proposed operation. Denial,
uncertainty, timeouts and unavailable state prevent dispatch. New/relabelled
children are subject to this review. Delegation reuse and continuation additionally
check the current revision and exact stopped task IDs inside their Convex mutation.
After approval waits, sandbox acquisition and immediately before terminal dispatch,
the operation rechecks its revision. Ordinary tools without restrictions do not
incur semantic review calls. Capture/review costs join existing run accounting.

Workers poll their own cancellation state and abort/close their own PTY scope;
provider cancellation is best effort after state revocation. Foreground commands
and managed interactive sessions use existing owned command handles. The explicit
background-command mode is denied for these managed Agent runs. Arbitrary shell
code can still detach processes, and an already dispatched request cannot be undone.
No egress firewall or deterministic proof of arbitrary command semantics is claimed.
Termination failures remain unconfirmed in the existing terminal execution record.

Deployment order is Convex, matching Trigger Preview worker, then Preview app.
Verify all three target the designated Developer deployment. Rollback consumers
and the message-capture caller together; retain saved constraints and do not silently
run a chat containing restrictions through an older unconstrained worker. Production
release and cross-chat acceptance remain separate decisions.

For Preview acceptance, use a disposable chat and synthetic local fixtures. Start
SSRF-labelled and unrelated XSS-labelled workers; stop only the SSRF work. Check
persisted cancellation before provider cancellation, owned process termination,
unrelated work, a later/reloaded turn, a renamed delegation attempt, and explicit
reopening. Also exercise an instruction arriving during an approval wait. Inspect
exact run versions and counts/status only in analytics; do not emit instruction,
command, target or finding text.
