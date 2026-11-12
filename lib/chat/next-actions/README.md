# Delivery diagnostics

`contextual_next_actions_settled` remains one browser-request lifecycle event, not
one event per HTTP retry or provider call. Existing `outcome`, `request_kind` and
timing definitions are preserved. `delivery_version=1` adds:

| Property        | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `http_attempts` | Fetches started in this lifecycle, including bounded retries of a retryable 409.                            |
| `retry_count`   | Fetches beyond the initial request, at most three.                                                          |
| `http_status`   | Last attempt's HTTP response status, only when one was received. Cleared before each retry.                 |
| `server_reason` | Exact allowlisted reason from the response header, when available.                                          |
| `failure_phase` | `http`, `decode`, `schema`, `network`, `deadline` or `lifecycle`, for failed/aborted/timed-out settlements. |

The server supplies bounded reasons through `X-HackerAI-Next-Actions-Reason`.
Unknown header values and failures reading optional metadata are ignored. Neither
raw headers, error messages, request bodies nor prediction text are analytics
properties. HTTP status and body are unchanged by instrumentation.

The browser retries a 409 only while its source may still be persisting:
`source_active`, `source_stale` (Agent marks the chat complete before saving its
final answer), or a missing/unrecognized reason from an older server. Canceled,
waiting and unsuccessful sources cannot clear by waiting, so that lifecycle
settles after one attempt. Other statuses are never retried. A retried response
must still match the current answer; a batch for another message is discarded.

Expected exclusions include active/waiting/canceled/unsuccessful/stale sources,
opt-out, unavailable chat, completed goals, expired sources, saved consumption,
restoration miss and normal dedupe/budget gating. Redis being unavailable has a
separate reason from normal reservation denial. Typed auth/access denials remain
separate from generic server errors. A withheld flag has a common `not_offered`
reason; no new client header identifies the randomized arm.

`empty` is not necessarily model abstention: inspect `server_reason` and match
generation evidence when needed. A restore is never a new model call. A final or
exhausted 409 lifecycle still reports `failed` for historical comparability; its
reason and attempt count identify a completion conflict rather than a provider outage.

These diagnostics do not change enrollment, assignment, flags, exposure events,
primary retention metrics, dates or grandfathered access. Do not use delivery
success to select the randomized outcome population. Monitor complete attempt
denominators, and treat older events without delivery metadata as unknown coverage.

Preview verification after deployment: use the designated Preview QA account,
finish a bounded chat, and inspect a single settlement with delivery version 1,
HTTP 200, one attempt and zero retries. Navigate away and return to exercise
restoration; expect a saved hint or `restore_miss` without new generation spend.
Use controlled test doubles for non-2xx, malformed responses, retries and deadlines;
do not manufacture failures or alter authorization gates in Production.
