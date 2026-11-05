# Next-message quality evaluation

This bounded runner compares the frozen pre-change prompt with the current
production implementation using synthetic conversations. It reads no customer
content, user notes, account settings, chat database or billing balance. Direct
Development provider calls incur company-funded API cost.

Dry-run (no model calls):

```sh
pnpm exec tsx scripts/benchmarks/next-actions/run.ts
```

For an authorized live evaluation, load the approved Development configuration
without printing it, then run, for example:

```sh
node --env-file=.env.local --import tsx scripts/benchmarks/next-actions/run.ts --live --cases=4 --output=/private/tmp/next-actions-evaluation/results.json
```

The maximum is 40 paired cases and 120 provider calls. Calls are interleaved,
sequential, nonthinking DeepSeek1017, with no retries and an eight-second budget
per batch. The baseline has one generation call; the candidate can additionally
make one short semantic-verification call. Empty generation skips verification.
Results contain synthetic generated text and belong in a private local artifact;
stdout contains aggregate progress only. A result file is evidence, never a
permission source. Do not use these consumed fixtures as a new holdout.

Score only the first retained draft, with opaque shuffled candidate labels:
0 invalid/unsafe/irrelevant/unsupported user fact/wrong language or an avoidable
empty; 1 generic/redundant/meta-discussion; 2 a grounded useful request;
3 directly advances a pending deliverable or concrete blocker. Correct empty
output after an explicit stop scores 3. Report useful **nonempty** coverage and
correct abstention separately. Review claims of user facts, authorization,
revoked intent and language independently from the utility average. Compare
case-level differences; repeated calls are not independent users.

## November 5, 2026 evidence

The original 60-case fresh prompt test improved mean utility from 1.917 to 2.250
on the 0–3 rubric, paired difference +0.333 (case bootstrap 95% interval
+0.117 to +0.567). Appropriate outputs rose from 51/60 to 55/60; that count
includes correct abstentions. A separate blinded Grok reviewer confirmed the
positive direction (+0.283; interval +0.017 to +0.550). Median generation
latency was 681 to 414 ms and p95 1001 to 606 ms. Invalid raw citations fell
from 10/136 to 0/76. This prompt-only result still failed the unsupported-user-
fact guardrail, so it was not considered safe to ship alone.

The fixed semantic verifier was then tested separately. It returned the exact
expected draft set on all 26 returned responses from 28 unseen cases, with two
four-second timeouts. Those timeouts remain failures with unknown cost. The
holdout p95 including failures was 4003 ms. A compatibility replay of 57
nonempty candidate batches changed five first-visible drafts; conservative
suppressions included reasonable hypothetical/clarification requests as well
as invented user details. This is a known coverage tradeoff.

A new 40-case paired full-pipeline test had no errors, all 116 provider calls
priced, and no treatment output flagged for invented user facts, revoked intent
or wrong language by either reviewer. Codex utility was 2.400 to 2.625; the
independent reviewer scored 2.300 to 2.525. Both differences were +0.225 with
95% intervals that include zero (Codex −0.025 to +0.450; independent −0.025
to +0.425), so this smaller confirmation is directional, not a second
statistically established win. Appropriate coverage was 36 to 37 of 40 for
Codex and 35 to 35 for the independent reviewer. Treatment had 33 useful
nonempty outputs by the independent reviewer, plus two correct stops. The
40-case set intentionally includes many unfinished deliverables and is not a
traffic-weighted estimate.

Full sequential pipeline latency was 536 to 577 ms median and 731 to 804 ms
p95. Provider cost was $0.00787818 to $0.008611776 for 40 batches per arm,
about 9.3% higher with verification. A subsequent six-case smoke test invoked
the actual source function: no unavailable outcomes, 11 priced provider calls,
no reasoning tokens, and no invented user facts in visible drafts. One unknown-
input case was conservatively empty. This is provider integration evidence,
not browser, deployed Preview or Production acceptance.

Several earlier prompt variants failed quality, citation, coverage or latency
guards and were rejected. Adding synthetic note/preferences or product-capability
context did not establish a safe improvement; the serving change adds neither
note reads nor capability claims. The 60-case winner's prompt was selected before
that test. Subsequent safety repairs used consumed failures for development;
the fresh 40-case pipeline test was registered before generation. Tests and
rubric were authored by the implementer; opaque labels and another model family
reduce, but do not eliminate, evaluator bias. Repeated development and selection
mean these intervals should not be treated as a conclusive population result.
Aggregate snapshots are in `2026-11-05-results.json`; full synthetic raw results,
failed stages and blinded mappings were retained in the task's private artifacts.

## Release and measurement boundaries

These results establish an offline prompt-quality gain and quantify the verifier's
tradeoffs. They do not establish more Tab use, solved tasks or retention lift.
The existing feature rollout is unchanged. Any live prompt comparison should
use a new stable experiment while preserving the historical stopped experiment.

New verified batches carry `validationVersion: 2`. Old unverified cached hints
are hidden until a new completed turn; restoration makes no model call. The
optional stored version is compatible with existing chat rows. Typed drafts,
explicit send, opt-out, eligibility and authorization gates remain unchanged.
Deploy the additive Convex validator before the web route that writes it.

For cost reporting, `cost_usd` is populated only when every attempted provider
call is priced. `known_cost_usd` is the available subtotal, even on unavailable
verification; `provider_calls`, `priced_provider_calls` and
`unknown_provider_calls` describe coverage. A missing cost is unknown, not zero.
Cost dashboards must sum the known subtotal (falling back to legacy `cost_usd`)
and deduplicate batches, while counting provider calls separately from hint
batches. Restoration contributes no provider cost. Update the saved cost insight
and operational monitor before releasing this change; neither was changed by
the offline benchmark.

Preview acceptance: complete a disposable chat on a large screen, check a useful
hint, press Tab (fills without sending), edit and explicitly send. Complete
another turn, switch chats and return, then reload: the verified batch should
restore without another generated event. Check opt-out, mode changes, `/goal`,
IME and cancellation still suppress hints as appropriate. Verify the Preview
Convex identity and PostHog project401167, full/partial provider cost events,
and absence of customer-content fields. Keep Production144137 separate.
