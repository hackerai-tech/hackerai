# Scheduled Agent tasks

Schedules run saved instructions as a **new Agent task**, in Cloud or on a selected
computer. Local schedules bind a persistent environment identity and an absolute
working folder. They do not inherit another task's messages or attachments.
Saving a schedule authorizes full tool access; the form explains this and normal
account usage/spending limits before saving.

## Execution and recovery

Convex owns the schedule, next due time, revision, and occurrence receipts.
Trigger's `dispatch-agent-schedules` clock runs once per minute in each environment;
its cron window must remain `0m` to avoid the provider's default scheduling window.
`scheduled-agent-run` claims the occurrence transactionally, checks current
billing-backed entitlement and the `scheduled-agent-tasks` flag, and starts the
normal Agent handler with an internally supplied identity. HTTP request bodies
cannot select that identity or override the saved execution target or full-access
permission setting.

Run now atomically reserves a queued receipt before the HTTP response acknowledges
it. The clock drains this durable outbox, so a provider outage cannot silently
lose an acknowledged request. Concurrent requests receive an immediate busy or
throttle response.

A retry keeps the same receipt, chat ID, message ID, and Agent idempotency key.
Pause, resume, and edits increment the revision so queued work from older
revisions cannot start. A run already handed to the Agent continues; users can
stop it in its normal task. Deleting a schedule preserves its result tasks.

A schedule never starts a second run while its previous run is starting,
running, or awaiting authoritative completion. An overlapping clock occurrence
is recorded as skipped. Missed intervals are not replayed as a backlog. Intervals
restart from the dispatch time; fixed clock schedules use the selected IANA time
zone. Nonexistent spring-forward times are skipped, and repeated fall-back times
run only at their first occurrence. One-time schedules disable after being claimed;
editing a consumed schedule to a future one-time date rearms it. Editing only a
name or instructions preserves an interval's existing next run.

Clearing `active_trigger_run_id` proves cleanup, not success. Reconciliation reads
the actual Trigger terminal outcome before recording finished, failed, or canceled.
Status reads are throttled per receipt and rotate the reconciliation batch. If
the provider outcome is unavailable, independently verified task cleanup permits
an **unconfirmed** result without claiming success; a still-active task remains
fenced. Final dispatcher failure
checks for an already-started child instead of replaying an uncertain start.
The external dispatch boundary is recorded once per receipt. A dispatcher retry
reconciles that original request instead of sending it again or replacing its
first-request timestamp. Even a retry skipped by a changed preflight keeps the
original request fenced. An ambiguous start remains **Start unconfirmed** until
it can be verified. Reconciliation revisits those receipts for matching task execution or
cleanup evidence. Retention preserves the active receipt even when overlapping
ticks accumulate. A failed status read never authorizes an automatic replacement run.

Each account may retain up to 20 schedules. Each schedule retains its latest 200
run receipts and shows its latest five runs; normal task retention is independent.
Account deletion fences execution immediately and deletes schedule instructions
and receipts through the existing bounded cleanup.

## Local execution

Only authenticated clients with a persistent environment identity can be selected;
legacy session IDs and the generic Desktop alias are not durable schedule targets.
Saving verifies ownership. Each task retains its own computer/folder snapshot, so
editing or deleting a schedule does not change the context of a manual resume.
The folder sets the starting directory; it does not restrict full tool access.

Local starts require live relay presence. Offline or unverifiable starts are
recorded as missed without a child Agent. Clock occurrences delayed more than two
minutes expire rather than catch up. The worker checks again before model work,
pins that run to one relay session, and stops on loss of that session. It never
switches to Cloud or a replacement session. Reconnect the selected computer,
review saved progress (a command may already have completed), then explicitly
resume the task. Local scheduled runs do not delegate independent subagents.
The clock and model still run server-side; the selected environment executes tools.

## Environment and rollout

The clock and dispatcher use their **worker's configured Convex deployment**;
callers cannot forward a backend URL into a scheduled run. Verify the worker's
Convex account/project/deployment and PostHog project independently from Vercel
before enabling the feature. Preview and Production require separate flag
definitions. Keep the owning Linear issue's rollout and readout plan current.

The server gates creation, editing, resume, and Run now on paid access and the
flag. Pause and delete remain available when the rollout is disabled. Every
execution rechecks entitlement, suspension/deletion fences, and the normal Agent
usage limits. Deployment must include both new Trigger tasks and Convex functions.

Actual UI exposure is `agent_schedules_viewed`; creation, actual Agent start,
and opening results are separate events. These events contain counts, timing
types, or statuses only. Saved names, instructions, outputs, and targets must not
be added to analytics.
