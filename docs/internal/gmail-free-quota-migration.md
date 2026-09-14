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

This PR does not perform a production migration. Do not set
`FREE_QUOTA_GMAIL_CANONICALIZATION=true` before completing the following procedure.
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
   Drain **all** free Ask streams and Trigger runs, including queued, retrying,
   suspended approvals and older worker versions. A zero lock count alone does
   not prove this. Do not force-expire locks or cancel billable runs to speed up
   the migration. Prevent old builds from serving free traffic throughout cutover.
5. Refresh the inventory and run `--action apply --all-free-runs-drained` with the
   same other arguments. The tool checks pause state, active locks and complete
   quota-key coverage before writing. Each alias transfer and forwarding pointer
   is atomic; a failed/uncertain apply may be retried while traffic remains paused.
   It preserves usage already in the destination and does not repeat a transfer.
   Never resume on an error or delete forwarding pointers.
6. Successful apply leaves state `migrated`, with free admissions still paused.
   Set `FREE_QUOTA_GMAIL_CANONICALIZATION=true` on Vercel and Trigger independently,
   deploy both, and verify the selected environment. Then run `--action resume
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
