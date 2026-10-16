# Engagement scope

Scope belongs to one chat and its delegated runs. Convex stores the canonical
rules, revision, pending clarification, and source records independently of
conversation summaries. Moving a chat between projects does not change scope;
a branched chat does not inherit permission from copied messages.

Authenticated request admission reads the persisted, visible user message and
extracts bounded changes using the existing Standard model. Each proposed edit
must cite a literal span in that message. The model's interpretation remains
probabilistic; source validation is not proof that it interpreted intent
correctly. A user can inspect/correct the saved policy through Scope in the task
header. Tool output, child prompts and hidden continuations cannot write policy.
A normal continuation reuses policy without another model extraction or scope
question. No separate authorization form is required.

Exact hosts and leading wildcards differ; wildcards exclude the apex. Bare hosts
use default HTTP(S) ports unless explicitly granted all ports. URLs bind origin
and path segment boundaries. Exclusions win. Passive-only grants do not permit
managed target fetches. Additional free-text activity restrictions are injected
into model context; they are not a general executable policy language. CIDRs,
query-scoped rules and scope only present in an unread attachment/link require
clarification or an explicit supported policy edit; they are never widened to a
hostname automatically. Scope changes are extracted from new genuine messages;
legacy chat history is not silently migrated into grants.

The pending update is recorded before extraction. A missing/invalid expected
policy or failed extraction holds dependent actions and keeps prior rules;
there is no allow-all fallback. Retry the same request or correct scope in the
editor. Concurrent edits use revision checks; a new message cannot supersede a
pending extraction. Clarification claims are shared across workers and survive
restart. Child agents never issue the parent's scope question again.

Every model step reloads policy. Cached conversation replay is disabled when a
scope section is present, so an old frozen system prompt cannot restore grants.
Managed URL dispatch reads the current policy and checks the submitted URL.
Terminal/delegation dispatch holds on unavailable policy or a revision changed
since model preparation. Existing approval modes remain separate.

This is not a firewall. Arbitrary shell commands, scanner traffic, browser CLI
navigation/subresources and requests already sent remain outside complete
network enforcement. The Jina reader controls downstream redirects; checking
its submitted URL cannot block every redirect hop. Cancellation of an existing
process is not an atomic scope revocation. Passive search results and observed
redirect/CDN/login relationships do not modify grants. A later managed transport
or egress boundary needs separate design and acceptance.

Source records are deleted in batches with their owning chat. No target,
prompt, rule, or restriction is included in the extraction cost/count telemetry.

## Verification

Use a disposable Preview task with reserved synthetic hosts. Ask for an exact
host, then continue and reload: the Scope panel should retain the rule without
another authorization question. Edit a wildcard plus an excluded host and
verify the exclusion and apex behavior with the pure matcher fixtures. Start a
child, narrow scope, and verify its next managed action sees the new revision.
Check a failed extraction, stale editor save and unavailable policy without
replacing the last valid rules. Test both Ask follow-ups and Agent runs against
the matching Preview app, Convex deployment and Trigger worker. Do not use a
live third-party target to validate these boundaries.
