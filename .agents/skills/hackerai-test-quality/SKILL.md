---
name: hackerai-test-quality
description: Write, review, and simplify HackerAI tests by identifying the failures they catch, choosing the right test boundary, and preserving unique regression coverage. Use for test changes, redundant-test audits, and weak or flaky tests; not as a requirement to add tests for every edit.
---

# HackerAI Test Quality

Keep tests that catch meaningful failures at a reasonable maintenance cost.
Follow the repository's validation, environment, and credential boundaries in
`AGENTS.md`. This workflow does not authorize production reads, paid provider
calls, infrastructure changes, or framework migrations.

## Decide what needs evidence

Before adding or removing a test, inspect the changed behavior, nearby tests,
the runner configuration, and relevant callers. State the concrete failure the
test should detect and the observable result that distinguishes broken from
working behavior. Derive that result from the requirement, public contract, or
reported bug, rather than copying the implementation into the expectation.

For a small change, a sentence in the work summary is enough. For a suite audit,
record each candidate's failure, existing coverage, and keep/rewrite/consolidate/
delete decision in the review or PR. Do not create a permanent test inventory.

Prioritize HackerAI's costly failures: incorrect charges or refunds, ownership
and authorization bypasses, lost messages or files, duplicate work, and broken
Agent cancellation, retry, or reconnect. Low-impact copy or styling edits may
need only existing checks or visual verification; avoid adding a test merely
because a file changed.

## Choose the narrowest honest boundary

- Use unit tests for business rules, parsers, and state transitions. Exercise
  relevant boundary values and invalid input; avoid testing language features,
  static constants, or third-party internals without a product contract.
- Use integration tests when the failure lies between collaborators, such as
  saving a streamed response, settling usage, or reconnecting a selected
  sandbox. Run the collaborating application code; mock external I/O at its
  boundary. A suite with every collaborator replaced by canned results is not
  evidence that the integration works.
- Use component tests for user actions and rendered outcomes. Prefer accessible
  roles and labels, actual interactions, and assertions on the resulting state.
  A container existing does not prove messages rendered or an error recovered.
- Use browser or native acceptance for browser layout, focus, session flows,
  and transport behavior that the test environment cannot reproduce. Follow
  `AGENTS.md` for Preview and Computer Use; jsdom cannot prove visual layout,
  and a web smoke test cannot prove Desktop execution.

At the shared streaming boundary, trace Ask and Trigger Agent callers. For
sandbox changes, identify affected cloud, local, and Desktop transports. Cover
distinct failure paths without multiplying every case across unaffected
providers or clients. Preserve focused regressions for boundary differences.

## Write assertions that can fail meaningfully

Prefer real local domain objects and application logic. Use controlled fakes
or mocks for services, clocks, and failures; do not mock the behavior being
tested. Include the relevant downstream failure or partial success when the
contract is recovery, not just invalid input at the entry point.

For a bug fix, reproduce the reported failure with the test before the fix when
practical, then verify it passes afterward. An import error or broken fixture
is not evidence that the test detects the bug. If red-before-green cannot be
demonstrated, explain what was actually exercised and what remains unverified.
For an existing critical test with doubtful assertions, consider a small,
temporary fault injection in isolation to check that it catches the claimed
failure; restore it afterward. Do not introduce mutation tooling by default.

Treat source-string matching, CSS-class assertions, broad snapshots, incidental
call counts, and truthiness-only checks as review candidates, not automatic
deletions. Some encode real configuration, security, or rendering constraints.
Name that constraint and prefer behavioral coverage where feasible. Exact calls
can be the contract for charge-once or cancel-the-correct-run behavior; incidental
helper ordering usually is not.

Avoid arbitrary sleeps and automatic retries that hide failures. Await observable
completion and control time where appropriate. Keep tests independent and clean
up their own mocks, timers, temporary data, and processes. Investigate flaky
behavior before choosing whether to fix, replace, or retire the test.

## Simplify without losing the reason for a test

Choose one action for each candidate:

- **Keep** when it protects a distinct requirement, regression, boundary, or
  recovery path, even if it is short or uses mocks.
- **Rewrite** when the failure matters but assertions are weak or coupled to
  implementation. Preserve any protection the existing guard provides until
  the replacement is validated. If an assertion cannot detect its claimed
  failure, record that coverage gap; removing the vacuous check does not close it.
- **Consolidate** when setup or cases repeat and a clearer test can preserve the
  same distinct inputs, failure paths, and outcomes. Avoid hiding case intent in
  elaborate helpers or shrinking a matrix without checking its boundaries.
- **Delete** when the behavior is intentionally obsolete, the assertion has no
  required behavior behind it, or named retained coverage catches the same
  failure. Weak evidence of a real requirement belongs under Rewrite, not this
  rule. Explain which deletion condition applies. A passing remainder or
  unchanged coverage percentage alone does not prove the deletion is safe.

For example, a chat smoke test that asserts only a wrapper exists may be
redundant with an interaction test that mounts the same path and verifies its
outcome. A refund retry test and a refund idempotency test protect different
failures. A layering class check may be the only guard against blocked dialogs;
preserve it until an appropriate replacement proves that behavior.

Do not pursue a target test count, line reduction, coverage percentage, or runtime
by dropping unique protections. Do not weaken assertions, skip failures, update
snapshots blindly, or lower thresholds just to get a green run.

## Validate and report

Instruction-only changes need structural validation and realistic decision
review, not tests that match the skill text. For test changes, run the nearest
affected suites. For a consolidation, verify all retained cases still execute;
for a deletion, run the named retained coverage where applicable. Follow the
repository's required hooks, CI, and shared-host worker limits, and avoid
duplicate full-suite runs.

Report the removed or changed tests and rationale, preserved risk coverage,
commands/results, and remaining gaps. Claim runtime or maintenance improvements
only to the extent measured or directly demonstrated. Passing tests do not prove
production, browser, or native acceptance.

## References

Consult these for test-design decisions; use the installed framework's docs for
version-specific APIs:

- [Testing Library's guidance on test boundaries](https://testing-library.com/docs/react-testing-library/faq/)
- [Playwright's behavior and isolation guidance](https://playwright.dev/docs/best-practices)
- [Community test-quality skill](https://github.com/adewale/testing-best-practices)

This skill owns HackerAI's test-selection workflow. Keep third-party skills and
manuals external rather than vendoring them into this repository.
