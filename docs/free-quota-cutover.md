# Consumer Gmail quota cutover

Consumer Gmail dot, plus and `googlemail.com` aliases share free request units,
monthly costs and active-run capacity after this cutover. Other domains retain
their existing identity. Login addresses, paid allowances, account identity,
referral attribution and influencer ownership retain their existing contracts.
Starter-bonus grants share the quota subject and remain idempotent.

Do not enable `FREE_QUOTA_GMAIL_CANONICALIZATION=true` before preserving existing
usage. This setting belongs to both the web service and every Agent worker.
The compatibility code ships with the setting absent/false; that alone does not
remediate the deployed alias gap.

## Prerequisites

Verify each environment separately: its WorkOS project/client ID, Redis host,
Vercel deployment/custom domain, Trigger worker, and applicable Convex mapping.
Never copy credentials or inventories between environments. Keep private account
inventories and operational evidence in the owning issue, outside this repository.

Deploy the compatibility code to every serving web/worker runtime first. Obtain
a complete private JSON array of current and historical email addresses for all
remaining quota keys, including deleted accounts. HMAC subjects cannot be
reversed. Unknown keys block cutover until inventory is recovered or they expire.
Keep the HMAC secret and v1 context unchanged.

With verified credentials supplied through the protected process environment:

```sh
pnpm exec tsx scripts/migrate-gmail-free-quotas.ts --action plan --emails /private/inventory.json --expected-redis-host VERIFIED_HOST
```

Review aggregate counts. `unknownQuotaKeys` must be zero. A partial inventory of
suspected aliases cannot prove historical usage preservation.

## Cutover

1. Run the CLI with `--action pause --expected-redis-host VERIFIED_HOST`. Free
   admissions and bonus grants stop; settlement remains available. Paid traffic
   is unaffected. Drain all free HTTP requests and Agent/subagent runs, including
   queued, retrying and approval-waiting runs. Zero Redis locks alone is insufficient.
2. While paused, enable `FREE_QUOTA_GMAIL_CANONICALIZATION=true` on web and workers
   independently. Deploy and verify every runtime. Drain old worker versions and
   refresh the private inventory after rollout.
3. Run the plan command with `--action apply --all-free-runs-drained
--canonical-runtimes-ready`. Apply rejects active locks, unknown keys and
   unpaused state. It atomically adds alias usage to existing destination counters,
   preserves expiry, merges grant markers and cumulative child checkpoints, and
   retains durable redirects. Retries do not transfer a counter twice.
4. Read back `free_quota_gmail_migration:v1:state=migrated`. Free traffic remains
   paused. Verify the canonical web/worker settings and then run `--action resume
--canonical-runtimes-ready --expected-redis-host VERIFIED_HOST`. Verify state
   `complete` and actual web and Agent behavior.

In Preview first, use two aliases of a tester-controlled mailbox. Seed synthetic
near-limit usage before migration. Verify shared daily/monthly capacity and lock,
completion/reload, bonus idempotency, and that deleting one account preserves the
other's consumed allowance. Confirm separate account history and paid limits.

## Recovery and local verification

An interrupted migration leaves free admissions paused. Retry apply after fixing
the cause. Never automatically resume on failure or delete redirects. After
cutover, roll back by pausing and fixing forward with migration-aware code; do
not turn canonicalization off or restore a build that ignores redirects.

The isolated verifier uses a task-owned Redis process and local REST bridge:

```sh
pnpm exec tsx --conditions=react-server scripts/verify-gmail-quota-migration.ts
```
