# AGENTS.md instructions

These instructions apply to Codex and other coding agents working in this
repository. Keep them durable, repo-scoped, and free of volatile business
metrics.

## HackerAI Product Direction

HackerAI is primarily built for individual security practitioners: bug bounty
hunters, solo pentesters, students, and technical builders who want practical
AI-assisted security workflows. Teams exist, but they are a secondary surface;
do not optimize product decisions, copy, onboarding, or UI around enterprise
procurement, compliance checklists, or admin-heavy workflows unless the task
explicitly asks for it.

When working on product, growth, pricing, onboarding, analytics, or UX,
optimize first for fast solo-user activation: chat-to-value, Agent mode,
local/desktop sandbox setup, cloud agent upgrade paths, file uploads, cost
clarity, referrals, and limit-pressure conversion. Favor self-serve flows,
simple language, and trust-through-transparency over enterprise sales language.

Security and trust work should be candid about current capabilities: public
source code, sandbox boundaries, subprocessors, data deletion, account security,
and any missing formal certifications. Do not imply enterprise-grade compliance,
managed security guarantees, or organizational trust claims unless they are
already implemented and documented.

For business, analytics, reliability, or production-regression questions, check
the codebase docs and instrumentation first, then use PostHog, Vercel
logs/inspect, Linear, or GitHub only when current external evidence is needed.
For production Vercel logs, use `--no-branch` unless intentionally investigating
a preview branch. Avoid hard-coding current revenue, user counts, team-share
percentages, pricing, or other volatile metrics in durable instructions; use
qualitative direction and source-of-truth references instead.

## Pull Request Review Workflow

When a PR has been pushed and is ready for review, do not send the final
completion message until CI and CodeRabbit are complete.

Use this wait pattern:

- Poll once within 30-60 seconds after PR creation to confirm checks started.
- While CI, Vercel, or Trigger checks are active, poll every 2-3 minutes.
- When only CodeRabbit remains, poll every 3-5 minutes.
- Treat 12-15 minutes as normal CodeRabbit runtime before calling it delayed.
- If the user asks for status, report briefly, then continue waiting unless told
  to stop.

After CodeRabbit finishes:

1. Check PR checks, CodeRabbit review status, review comments, review threads,
   and issue comments.
2. Treat every CodeRabbit suggestion as a hypothesis, not automatically correct.
3. For each actionable comment:
   - If valid, fix it with the smallest appropriate change, commit, push, and
     wait for checks/CodeRabbit again.
   - If false positive or not applicable, leave a brief PR reply explaining why
     no change is needed.
   - If it is a nit, fix it when low-risk and useful; otherwise explain why it
     was skipped.
4. Repeat until CodeRabbit is complete and there are no unresolved valid
   actionable comments.

Only finish when:

- The PR is not draft.
- The branch is pushed.
- The local worktree is clean.
- Required CI checks are passing.
- CodeRabbit is complete.
- Valid CodeRabbit comments are fixed or explicitly answered.
- Visual verification is done when the PR has meaningful UI/user-visible impact.
- Manual verification steps are included when the PR is user-facing, risky,
  important, or needs human validation.
- The only remaining blocker is human review, merge approval, or the listed
  manual verification.

## Thread Coordination

Codex can use separate threads for independent work when that improves
execution, review, or verification.

Consider a separate thread when the work has a clear boundary, such as:

- a distinct feature or bug that should become its own PR;
- broad or high-risk visual QA worth an independent pass;
- a long investigation that can run while implementation or PR checks continue;
- a validation or follow-up task that does not need the current thread's full
  context.

Keep work in the current thread when it is one PR, a tightly coupled refactor, a
small follow-up, overlapping file edits, or depends heavily on context from the
current conversation.

When creating or handing off a thread, include a compact brief with: objective,
repo/worktree/branch, relevant files or PR, constraints, what not to change,
required verification, expected deliverable, and how results should be reported
back.

For multi-PR work, split threads only when each PR can be reviewed and merged
independently. Keep one parent thread responsible for coordinating scope,
avoiding overlap, and integrating results.

## Visual Verification

Use visual verification in the same PR thread by default when the PR changes UI,
chat message rendering, file/image display, onboarding, pricing, sandbox
selection, frontend routes/components, or prompt behavior that creates a
meaningful user-visible UI result.

Do not require browser/computer visual checks for backend-only, test-only,
prompt-only, CI, logging, or non-visual agent orchestration changes unless there
is a plausible user-facing UI impact.

Create a separate visual QA thread only for broad or high-risk UI changes where
independent review is worth the handoff cost, such as multi-page flows, many
responsive states, login/session setup, or visual polish passes.

## Manual Verification Notes

After checks and CodeRabbit are complete, include short manual verification
steps when the PR is user-facing, risky, important, or cannot be fully validated
by tests.

Use this for changes involving payments, auth/account security, agent or
sandbox behavior, local/desktop connections, file uploads, browser automation,
important prompt behavior, analytics, or major UI flows.

Manual steps should say:

- Where to test.
- What to do.
- What should happen.

If manual verification is not needed, say automated validation was sufficient.
