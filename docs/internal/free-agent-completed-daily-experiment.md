# Completed Free Agent daily allowance

[HAC-169](https://linear.app/hackerai/issue/HAC-169) owns the hypothesis, rollout,
metrics, review date, rollback conditions, and cleanup. This is separate from the
rejected `free_agent_daily_cost_v1` experiment; do not re-enable that flag.

`free-agent-completed-daily-v1` compares current access with one naturally
completed Agent response per UTC day, within all existing request/spend/sandbox
limits. It does not guarantee a finished security task. Ask and paid access are
unchanged. Eligibility requires authenticated Free entitlement, analytics consent,
and a trusted ingress country outside the regional subscription-first population.

Assignment uses the authenticated WorkOS user ID. The daily marker uses the
existing free quota subject to retain anti-abuse boundaries. The worker rechecks
under the existing free-run lock, before consuming request allowance; resumed
approval sessions are not interrupted. A queued treatment request reloads paid
entitlement before blocking. Dependency failure preserves baseline access.

Only a successfully persisted, nonempty assistant reply with `finishReason=stop`
and no error, cancellation, step/time/budget/token/recovery truncation sets the
idempotent Redis marker. The completion day determines the bucket, which expires
at next UTC midnight. This measures a completed response, not verified usefulness.

Server flag evaluation suppresses automatic exposure. Composer rendering and
eligible quota checks explicitly emit `$feature_flag_called` with this key,
variant, and `exposure_surface`. Experiment exposure filters require the surface;
background assignment lookups cannot enter the denominator. No user content is
sent. Payment outcomes use the existing positive-payment `subscription_started`
free-to-paid event; mature cohorts and invoice reconciliation remain required.

Vercel and Trigger must both deploy this code and use the matching PostHog project
(Preview 401167, Production 144137) and designated Convex account/deployment.
Changing a flag afterward affects new attempts without redeployment. Disable both
flags to restore baseline access; retain experiment history until the readout.

## Acceptance

On the verified Preview URL, use a disposable Free test account with a connected
local/desktop sandbox. Complete a bounded Agent request and reload its saved
reply. Confirm the next Agent submission is blocked with the local reset time,
the draft remains, Ask works within existing limits, and Upgrade opens pricing.
Verify control, paid entitlement, declined consent, regional exclusions, failure,
cancellation, approval/resume, midnight reset, concurrent submissions, and flag-off
recovery. Confirm the actual Trigger run uses the same commit and Preview project.
A UI-only smoke test is not full acceptance. Do not expand Production before the
issue's acceptance and measurement requirements are satisfied.
