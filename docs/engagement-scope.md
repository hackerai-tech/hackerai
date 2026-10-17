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
there is no allow-all fallback. Regeneration or the next genuine request retries
the original pending source before admitting a new instruction. A failed narrowing
is never silently superseded by a continuation. The scope editor also provides
recovery. Concurrent edits use revision checks. Clarification claims are shared across workers and survive
restart. Child agents never issue the parent's scope question again.

Every model step reloads policy. Cached conversation replay is disabled when a
scope section is present, so an old frozen system prompt cannot restore grants.
Managed URL dispatch reads the current policy and checks the submitted URL.
Terminal/delegation dispatch holds on unavailable policy or a revision changed
since model preparation. Existing approval modes remain separate.

Chat scope alone does not enforce arbitrary shell, scanner, or browser traffic.
The separate cloud workspace network setting below adds E2B egress controls
within its documented protocol limits. Requests already sent remain outside
complete revocation. The Jina reader controls downstream redirects; checking
its submitted URL cannot block every redirect hop. Cancellation of an existing
process is not an atomic scope revocation. Passive search results and observed
redirect/CDN/login relationships do not modify grants. Broader managed transport enforcement needs separate design and acceptance.

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

## Cloud workspace network settings

Settings > Agents exposes an explicit workspace-wide outbound network policy:
existing internet access, allowed destinations only, or no internet. The policy
is stored per user, because cloud workspaces are currently reused across chats.
Chat scope never silently changes this shared setting. Local/Desktop connections
and server-side reader requests are outside this E2B control.

The E2B adapter updates running workspaces in place and reads the resulting
configuration back before reporting success. It never deletes a workspace or
writes its files. Paused workspaces receive the saved policy on acquisition;
new workspaces are created with it. Provider writes are serialized with a
revision and bounded operation fence. Failures retain the desired policy and
report uncertain/partial application; an interrupted update can be retried after
the fence expires. Failures before any provider write release the fence immediately
so canceled reads do not delay the next attempt. A provider operation already dispatched is not an atomic
revocation of existing traffic. Externally managed egress proxies or credential
transforms are rejected rather than cleared by this editor.

Only hostnames/wildcards and IPv4 addresses/CIDRs are supported. E2B hostname
filtering covers HTTP 80 and TLS 443 and allows its DNS resolver. IP grants cover
other ports too. URL paths, per-domain exclusions, activity limits, QUIC hostname
filtering and strict shared-CDN isolation cannot be represented by this setting.
Do not expand a hostname to its resolved/shared IP or flatten a task scope with
exclusions into a broader allowlist. The canonical engagement matcher remains
necessary.

For Preview acceptance, record the sandbox ID and a disposable file checksum,
save a restricted policy in Settings, and verify application-level responses
for an allowed and a blocked destination. A successful TCP connect alone does
not prove traffic passed E2B's filter. Verify the same ID/checksum after updating
and reconnecting, test offline execution, then restore the test account's
original network policy. The default behavior stays unchanged until a user
explicitly saves this setting.
