# Agent Approve for me

Issue: [HAC-61](https://linear.app/hackerai/issue/HAC-61/add-auto-review-permission-mode-for-hackerai-agent)

PostHog flag: [`agent_auto_review_v1`](https://us.posthog.com/project/144137/feature_flags/808511)

## Implementation plan

1. Extend the persisted Agent permission union with `auto_review`, keeping
   `full_access` as the default and preserving stored Ask for approval and Full
   access values.
2. Keep the current terminal and file approval gates as the only execution
   boundary. Add the exact command or file mutation to the in-memory review
   request without persisting it or sending it to analytics. For live terminal
   input and kill actions, include the originating command, working directory,
   exact translated input, and bounded recent terminal output. Missing or
   truncated terminal state routes to the human, and an automatic approval is
   invalidated if the session changes while review is running. Read-only
   `wait` and `view` interactions continue without review.
3. Add a dedicated reviewer module that:
   - extracts only user-authored messages as trusted authorization context;
   - labels assistant rationale, tool output, web content, and referenced file
     content as untrusted evidence;
   - applies narrow deterministic decisions only for clearly safe or clearly
     forbidden actions;
   - otherwise calls a dedicated provider alias in a separate, tool-less
     `generateText` request with a typed `approve | ask_user | deny` schema;
   - deterministically routes explicit filesystem deletion commands to the
     human approval path, including deletion typed into a returned shell;
   - routes timeout, provider, parse, truncation, and missing-context failures
     to `ask_user`.
4. Integrate review before the existing durable human wait:
   - `shadow`: record the reviewer verdict without showing it, then keep the
     human authoritative;
   - `enforce/approve`: revalidate current authorization, entitlements, and
     sandbox identity, then approve that exact action once;
   - `enforce/ask_user` or `enforce/deny`: reuse the existing signed Trigger
     Session input path and let the human make the final decision. A reviewer
     denial means only that the action cannot be approved automatically.
     Stream a privacy-safe lifecycle containing only correlation IDs, timestamps,
     and status. The tool row shows `Reviewing action` only after 450 ms to avoid
     flicker, briefly shows an automatic approval, and otherwise hands off to the
     existing human approval card.
5. Keep reusable target/prefix grants human-only. Existing human-created grants
   may continue to match, but Approve for me never creates or broadens a grant.
6. Track consecutive and rolling human denials after an enforced review, and
   abort retry loops after 3 consecutive denials or 10 denials in the last 50
   reviews. Automatic reviewer denials never abort the action before the user
   can decide.
7. Add a server-evaluated selector endpoint for the inactive multivariate
   PostHog flag. If the flag is off, unavailable, or malformed, hide Approve for me
   and route any stale stored selection through human approval.
8. Emit privacy-safe exposure, decision, and human-comparison events containing
   only rollout phase, verdict, risk category, latency, failure class, outcome,
   and surface. Never emit commands, targets, paths, prompts, credentials, file
   contents, or reviewer rationale.
9. Cover parsing, deterministic rules, prompt-injection boundaries, exact-action
   behavior, terminal-state mutation and credential prompts, failure modes,
   denial limits, shadow/enforce paths, authorization and sandbox changes, all
   sandbox types, UI selection, and existing-mode regressions. Run focused
   tests, the full suite, typecheck, lint, formatting, production build, and
   responsive browser verification.
10. Snapshot the selected permission mode into each Trigger run. Changes made
    while a run is active apply to the next run; reconnecting resumes the stored
    run and approval Session without re-reading the current selector value.

## Rollout and cleanup

The flag is created inactive with `shadow=100%`, `enforce=0%`, and a 0% release
condition. After merge, enable shadow for an explicit internal allowlist, then
expand shadow and enforcement only after the HAC-61 guardrails are healthy.
Disabling the flag immediately restores human approval for Approve for me users.

Every Vercel preview uses `enforce` independently of PostHog project, identity,
flag state, or branch-scoped environment variables. This keeps feature previews
directly testable without changing production rollout configuration. Production
and local development continue to fail closed through the PostHog assignment
path.

Review on 2026-08-23 UTC. After full rollout and one stable review window,
remove the flag evaluation and shadow comparison plumbing. If guardrails fail,
disable the flag and remove Approve for me while retaining the existing modes.

## Explicit limits

Approve for me is probabilistic and can make mistakes. It does not expand sandbox
permissions, enforce target scope, control network reachability, or provide a
deterministic security guarantee. It reviews only actions that already cross
HackerAI's current approval gate.
