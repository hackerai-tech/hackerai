---
name: hackerai-code-first-engineering
description: Audit recurring HackerAI engineering mistakes and development instructions for fixes in APIs, defaults, tooling, and automated checks. Use before adding a codebase workaround to a skill or AGENTS.md, or when asked which instructions could become code. Does not require an instruction audit for every routine edit.
---

# HackerAI Code-First Engineering

Make correct use of HackerAI's codebase straightforward and mechanically
checked wherever practical. Skills retain the judgment and context that remain
necessary. Follow `AGENTS.md` for task scope, environment boundaries, validation,
and review; this workflow grants no additional operational access.

## Find the responsibility behind the instruction

Inspect the relevant development skill or rule and trace the actual entry
points, implementation, callers, and existing checks on the task's current base
revision. Distinguish coding-agent instructions from product Agent prompts and
vendored runtime skills; audit the requested surface before extending scope.
Treat words such as "always," "never," "remember," and "manually" as leads,
not proof that an instruction is unnecessary.

For each candidate, name the concrete mistake, the code that owns it, what is
already enforced, and what still depends on the agent. Check command entry
points as well as helpers: an existing guard is only effective on paths that
invoke it. Do not call an implemented safeguard a missing feature.

## Choose where the guarantee belongs

Prefer the earliest practical mechanism that handles the demonstrated failure:

| Layer            | HackerAI application                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Codebase         | Explicit environment selection, safe defaults, shared admission logic, owned cleanup, resumable operations and stable retry identities |
| Automated checks | Types, validators, lint and CI that reject invalid combinations or unsupported runtime contracts                                       |
| Verification     | Behavioral tests and real affected journeys, including relevant cancellation, retry and reconnect paths                                |
| Prose            | Research interpretation, product intent, authorization boundaries and operational context that still require judgment                  |
| Human review     | Material decisions and evidence gaps that automation cannot resolve                                                                    |

For example, inspect the existing dependency guard and local Convex startup
helper before proposing another setup rule. Desktop QA identity metadata must
be distinguished from verified backend and worker identity. A research runner
can own request validation and interruption recovery; causal interpretation
still requires analytical judgment.

## Implement and simplify within scope

For an authorized fix, make the smallest change in the owning API, adapter or
tool. Reuse existing safeguards. Avoid broad new frameworks, speculative
abstractions, and scripts that merely print reminders. A prompt rewrite or a
warning alone does not establish a deterministic guarantee.

Verify the failure at the boundary where it can occur. Follow the
[test-quality skill](../hackerai-test-quality/SKILL.md) when changing tests;
do not add tests that only match instruction wording. Preserve required hooks
and CI, and use browser/native acceptance when the affected journey needs it.

After the replacement is proven and covers the relevant callers, remove or
shorten the redundant procedural instruction and point to the supported entry
point. Preserve authorization and environment boundaries, and retain any
temporary workaround until its replacement is effective.

For an audit-only request, report prioritized candidates with source pointers,
existing enforcement, the proposed owner/mechanism, and the evidence needed.
Keep the findings in the task or PR rather than a permanent skill backlog.
Distinguish recommendations, implemented checks, and observed runtime results.
