# Existing empty E2B workspaces: phase 1

Owner and rollout decisions: [HAC-113](https://linear.app/hackerai/issue/HAC-113/phase-1-migrate-existing-empty-e2b-workspaces-to-miosa-preserve).

This phase switches only a verified pristine existing workspace. Users with
files remain on E2B; file transfer is a later phase. E2B sources are retained,
including old templates and versions. Migration never deletes a source.

## Eligibility and proof

The existing Miosa provider assignment, paid-plan gate and non-European
execution checks still apply. The additional flag
`miosa_empty_e2b_workspace_migration_v1` defaults to false when absent or
unavailable. Discovery must finish in every configured E2B cluster. Phase 1
requires exactly one US workspace, paused, with no attached volumes, a verified
auto-pause lifecycle and no resumed commands. Multiple workspaces, running
workspaces, unknown lifecycle, other regions and failed reads are skipped.

A server-side reviewed pristine-template fingerprint is required. The probe
reads the complete persistent filesystem, including hidden files, `/root`,
temporary files, custom tools and system configuration. It compares contents,
paths, modes, ownership, links and extended attributes. Empty files count.
Only the kernel `/proc`, `/sys` and `/dev` trees are omitted. Unsupported mounts,
special files, unreadable paths, changing files, time/size/entry limits and
malformed results are unknown, never empty. No filename, file contents or digest
is sent to analytics. The VM returns only a digest and entry count.

The comparison intentionally favors false negatives: generated system files and
runtime noise can keep an otherwise unused workspace on E2B. Do not loosen the
probe or copy a customer's current fingerprint into the baseline to increase
eligibility. Baseline compatibility must be demonstrated with separate pristine
instances and an existing disposable paused instance before activation.

## Baselines and activation

After independently verifying the intended E2B account and environment, capture
a baseline from a new disposable instance of the intended template:

```sh
pnpm exec tsx scripts/miosa-empty-baseline.ts --env-file /absolute/verified/environment --template-id TEMPLATE
```

The tool uses only the explicitly selected file's US E2B credential. It never
loads another checkout's configuration or accepts an existing user sandbox ID.
It runs two bounded probes and kills only its own disposable sandbox. An
unstable capture or failed cleanup fails the command. Output is a JSON array
of `{version: 1, templateId, digest}` records for the non-secret configuration
`MIOSA_EMPTY_E2B_BASELINES_JSON`. Review and validate the complete JSON, and
perform a sanitized read-back after saving it. Duplicate template records,
missing baselines, unknown templates and malformed configuration disable their
migration. Baseline configuration changes require new Vercel and Trigger
deployments. Never share environment credentials between these services or
between Preview and Production.

Shipping the code does not activate migration. Verify Vercel/Trigger/Convex
environment identities before live acceptance or configuration changes. Configure
the separate flag in Preview project **401167** at 100% of eligible test users;
Production project **144137** starts with an explicit internal allowlist only
after acceptance and a reviewed rollout decision. Retain environment targeting
and stable user-ID assignment. Verify the actual Trigger workers' project keys,
read back both flag definitions and do not copy Preview's percentage to
Production. Changing only the flag affects new acquisition without redeploying.

## Cutover, retention and recovery

A non-expiring per-user Redis record fences inspection across acquisitions and
cached E2B manager access. The source is rechecked after claiming the fence,
resumed for inspection and scanned twice. A failed inspection releases only its
own fence, leaves all files intact and continues with E2B. Inspection requires
Linux Python/xattr support and can take up to two 50-second command windows.
Its E2B compute is migration overhead; it is not recorded as a user tool call.
The inspection connection has a two-minute auto-pause lease; it is never
force-paused because another worker may have renewed an active lease.

After proof succeeds, the record pins the user to Miosa **before** Miosa can
accept writes. Creation/readiness errors after this point require retry or
operator recovery. They cannot fall back to the retained, now potentially stale
E2B copy. The general rollout and migration flags stop new enrollment; disabling
them does not move an already-migrated user back to E2B. Existing Miosa users
without a migration record retain the ordinary acquisition fallback behavior.

Redis migration records are durable routing state, not expendable rate-limit
cache: retain them without TTL, eviction or bulk cache flushing, preserve them
during Redis maintenance, and use the same environment's Redis in Vercel and
Trigger. Production fails closed if this store cannot be read. A crashed
`checking` record deliberately needs recovery instead of expiring into a second
writer. Before clearing one, stop the affected runs, verify both provider
identities/state and that no Miosa workspace received writes. An ambiguous
commit or a `miosa` record must keep Miosa authoritative. Recover Miosa or perform
an explicit file-preserving reverse migration; never simply delete that record.
Only a successful explicit reset of both providers clears a completed record.
There is no automatic source-retention cleanup in this phase.

## Measurement and manual acceptance

`miosa_empty_e2b_migration_checked` reports bounded inspection/skip reasons.
`empty_verified` means routing was committed, not that Miosa acquisition worked.
`miosa_empty_e2b_migration_exposed` records successful actual Miosa acquisition
for migrated users, deduplicated per Trigger run. Join this to existing
acquisition and Agent completion events. Review completion, inspection overhead,
acquisition/restore errors, inaccessible files and split-provider incidents.
Keep baseline/inspection overhead separate from normal user-run cost comparisons.

On the verified user-facing Preview URL, using disposable paid test accounts:

1. With migration disabled, verify existing E2B reuse is unchanged.
2. Capture/review a stable baseline, enable only the test population, and use
   a matching paused empty workspace. Submit a bounded Agent command. Verify
   actual Miosa acquisition, completion, rendering, reload and reconnect. Verify
   the original E2B ID remains available and retains its files.
3. Repeat with a hidden file, empty file, upload, `/root` report, temporary output,
   installed tool, modified default, active command and old-version workspace.
   Each remains on the original E2B workspace without deletion or replacement.
4. Exercise failed discovery, malformed/missing baseline, probe timeout,
   concurrent acquisition, interrupted inspection and lost commit response.
   Unknown checks preserve E2B; ambiguous committed transitions remain fenced.
5. After successful migration, create a Miosa-only marker. Disable both flags
   and force an acquisition failure. Verify the old E2B copy is never exposed;
   recover Miosa, reconnect and verify the marker. Then explicitly reset the
   disposable workspaces and verify completed routing state is cleared.

Do not expand to external users until these checks pass. Review the initial
cohort after 48 hours and 100 completed affected runs; low traffic extends the
window. Stop new migrations on any file-loss, isolation, correctness or material
reliability/cost regression. Users with files stay deferred until a separate
file-preserving migration passes acceptance.
