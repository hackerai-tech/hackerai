# Gmail aliases and free activation

Consumer `gmail.com` and `googlemail.com` addresses share free quotas after removing
dots and the plus suffix. Other domains retain the historical trim/lowercase rule;
in particular, custom Google Workspace domains are not canonicalized. This is
only a quota/abuse identity: WorkOS IDs, login addresses, Stripe customers, billing
addresses, paid allowances and analytics account IDs remain separate.

The HMAC secret and v1 context must stay unchanged. The already-canonical mailbox
keeps its existing key. Alias counters are added to that key, never replaced with
a fresh allowance. Daily and monthly windows keep their existing expiry. Referral
balances are added with the latest existing expiry, and grant markers are merged
so a previously awarded signup bonus cannot be awarded again. Shared quota state
survives deletion of an individual account and expires normally.

## Cutover (each environment separately)

This PR does not perform a production migration. Enable
`FREE_QUOTA_GMAIL_CANONICALIZATION=true` only during the paused cutover below.
Preview and Production require independent verified Redis and HMAC credentials,
user inventories and execution records. No Convex schema migration is needed.

1. Verify and record the intended environment and its WorkOS project, Redis host,
   Vercel deployment/custom domain and Trigger worker version. Follow AGENTS.md's
   full Convex account/project/deployment mapping before inspecting configuration.
   Deploy this compatibility code to **every** Vercel and Trigger runtime with the
   switch absent/false. Existing free behavior continues until migration starts.
2. Obtain a complete private JSON array of email strings from that environment's
   WorkOS users, plus historical/deleted-user addresses for any remaining quota
   keys. Do not commit this inventory or print addresses. A list of just the
   suspected abuse cohort is insufficient. HMAC keys cannot be reversed; unresolved
   keys require the missing inventory or waiting for their natural expiry.
3. With credentials supplied through the operator's protected environment, run:

   ```sh
   pnpm exec tsx scripts/migrate-gmail-free-quotas.ts --action plan --emails /private/inventory.json --expected-redis-host VERIFIED_HOST
   ```

   Review aggregate counts only. `unknownQuotaKeys` must be zero before apply.

4. Run the same command with `--action pause`. This pauses all free admissions and
   referral grants; final cost settlement continues. Keep paid traffic running.
   Drain **all** in-flight free HTTP admissions, Ask streams and Trigger runs, including queued, retrying,
   suspended approvals and older worker versions. A zero lock count alone does
   not prove this. Do not force-expire locks or cancel billable runs to speed up
   the migration. Prevent old builds from serving free traffic throughout cutover.
5. While paused, set `FREE_QUOTA_GMAIL_CANONICALIZATION=true` on Vercel and Trigger
   independently, deploy both, and verify every runtime. New payloads now carry
   canonical subjects, but free admissions remain blocked. Drain the old versions
   and refresh the inventory **after** this rollout, so no new legacy payload can
   be created outside that inventory. Run `--action apply --all-free-runs-drained
--canonical-runtimes-ready` with the same other arguments. The tool checks pause state, active locks and complete
   quota-key coverage before writing. Each alias transfer and forwarding pointer
   is atomic; a failed/uncertain apply may be retried while traffic remains paused.
   It preserves usage already in the destination and does not repeat a transfer.
   Never resume on an error or delete forwarding pointers.
6. Successful apply leaves state `migrated`, with free admissions still paused.
   Verify the selected environment and canonical runtimes again. Then run `--action resume
--canonical-runtimes-ready --expected-redis-host VERIFIED_HOST`. Read back state
   `complete` and verify the actual custom domain and a new Trigger run.
7. In Preview, use two disposable accounts for aliases of a mailbox the tester
   controls. Verify their original login/billing addresses and account history stay
   separate. Send a bounded Ask and local Agent request, check completion/rendering
   and reload. They must share daily/monthly capacity and a concurrency lock. Seed
   synthetic near-limit usage before migrating and prove no extra allowance is
   created. Delete one account and verify the other's used quota remains consumed.

Rollback: pause free admissions and fix forward using a migration-aware build.
Do not deploy pre-compatibility code or turn canonicalization off after cutover:
new aliases could again receive independent limits. Forwarding pointers have no
TTL because old durable payloads must always charge the canonical subject. Account
deletion must not remove these pointers or shared counters. The pause has no TTL
and requires an explicit resume; monitor it during the maintenance window.

## Hosted migration runner

When Vercel holds a non-readable sensitive quota HMAC, use
`POST /api/internal/quota-migration` inside that environment. The HMAC and WorkOS
key are consumed there; the response contains only aggregate progress. This is
an operator endpoint, independent of user sessions, and is disabled by default.
Do not add a credential-export endpoint or generate a replacement quota HMAC.

After independently verifying the environment mapping, configure these temporary
variables separately in the authorized Vercel environment. For Preview, scope
them to the migration PR branch. Keep each operator token in protected storage;
only its SHA-256 digest is deployed. Use different tokens in each environment.

- `FREE_QUOTA_MIGRATION_OPERATOR_SHA256`: digest of a random 32-byte token encoded
  as 64 lowercase hex characters. Authentication is `Authorization: Bearer TOKEN`;
  supply it from protected storage in memory, never a command argument or log.
- `FREE_QUOTA_MIGRATION_OPERATOR_EXPIRES_AT`: ISO timestamp within the next
  24 hours. The route rejects expired access even on an older deployment.
- `FREE_QUOTA_MIGRATION_ENVIRONMENT`: `preview` or `production`, matching Vercel.
- `FREE_QUOTA_MIGRATION_REDIS_HOST`, `FREE_QUOTA_MIGRATION_CONVEX_URL`, and
  `FREE_QUOTA_MIGRATION_WORKOS_CLIENT_ID`: independently verified runtime targets.

Deploy and verify the actual Preview URL/custom production domain. All requests
are JSON commands with an `action` field. No request accepts scripts, email
inventories, quota subjects, credentials or alternate provider URLs.

1. Call `inventory` repeatedly until `inventoryComplete`; each request fetches
   one WorkOS page and stores only legacy/canonical quota-subject mappings in the
   same Redis database. Cursors stay server-side. `status` returns progress.
2. Call `audit` until `auditComplete`. This scans every quota-key page and reports
   `unknownQuotaKeys`. Any unknown key blocks `pause` and `apply`. Current WorkOS
   users may not cover historical/deleted addresses; the hosted runner cannot
   manufacture those. Resolve missing inventory through the offline runbook or
   wait for unknown keys to expire. Never delete counters to pass coverage.
   `restart-audit` clears the prior audit on its next page; `restart-inventory`
   starts a fresh WorkOS traversal while retaining previously known mappings.
3. With zero unknown keys, follow the cutover/drain procedure above and call
   `pause`. This invalidates the preflight inventory/audit. Deploy and verify
   canonical Vercel and Trigger runtimes, drain all free work, then repeat the
   complete inventory and audit while paused. `auditHasLocks` must be false;
   even then, independently verify queued, retrying and approval-waiting runs.
4. Call `apply` with `allFreeRunsDrained: true` and
   `canonicalRuntimesReady: true` only after recording that evidence. Repeat
   until `applied` and state `migrated`. Each page uses the existing atomic alias
   transfer, preserves expiry and usage, and can be retried after a lost response.
   Apply errors leave admissions paused. Fix forward; never toggle off
   canonicalization or reset migration state to escape a failure.
5. Verify canonical runtimes again, then `resume` with
   `canonicalRuntimesReady: true`. Confirm state `complete`, an actual Ask reply
   and a new Agent run. `cleanup` removes only the runner's inventory/progress;
   it preserves all usage, forwarding pointers and the completed migration state.
6. Remove the temporary operator configuration, redeploy, verify the route returns
   404, and remove the endpoint/proxy exemption after both environments finish.
   Expiry remains a backstop for old deployments. HAC-115 owns this cleanup.

The runner uses a lease with guarded writes so concurrent/expired requests cannot
overwrite later progress. Each call handles one page; do not execute calls in
parallel. A changed HMAC during an inventory is rejected. Intermediate Redis
inventory has no TTL to avoid losing recovery data during a paused cutover;
explicit cleanup is required. This route does not itself prove runtime drainage,
perform deployment changes, or enable the monthly budget experiment.

## Conversion reporting

`free_response_completed` v1 is emitted by the shared Ask/Agent completion logger
only for a successful, nonempty assistant reply on the free tier, excluding
automatic continuation. It contains mode, tier and definition version, with no
prompts, targets, emails, quota hashes or chat IDs. This is a measurable activation
proxy (a completed response), not a claim that the user's security task succeeded.
Existing Agent completion and billing events remain intact.

The [saved production report](https://us.posthog.com/project/144137/insights/wYsMsTPL)
uses [this HogQL source](free-activation-conversion.sql) in project 144137;
validate independently in Preview 401167. It reports raw account creation, seven-day
paid conversions, successful-response activation, and activation-to-paid conversion
side by side. It deduplicates by authenticated account ID, preserves raw signup
counts, excludes pause resumes, and only includes accounts with a full seven-day
follow-up. Outcomes remain visible through now, beyond the signup cohort boundary.
Direct purchases before activation contribute only to the raw conversion metric.

Activation metrics are NULL for cohorts beginning before the first observed v1
event. Do not interpret historical missing events as failed activation. Record the
actual all-runtime instrumentation deployment time, and exclude the rollout week
from comparisons. The first fully covered weekly cohort needs seven days to mature.
The newest/oldest rows can be partial weeks; compare matching complete periods.
`subscription_started` is an observed user conversion, not proof of a first-ever
Stripe customer; use Stripe history if the question requires first-ever purchases.

## Verification

Run the focused Jest tests and `pnpm typecheck`. For real Redis coverage, install
`redis-server` locally and run:

```sh
pnpm exec tsx --conditions=react-server scripts/verify-gmail-quota-migration.ts
```

The script owns an ephemeral Redis process/socket and local REST bridge, exercises
actual quota functions with synthetic data, and removes its runtime state afterward.
It never selects a cloud Redis database or changes account/billing data.
