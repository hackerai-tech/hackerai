# Existing E2B workspace migration

Owner and rollout: [HAC-113](https://linear.app/hackerai/issue/HAC-113).

This replaces pristine-template fingerprinting. No baseline JSON is required.
The migration restores `/home/user` and keeps a compressed copy of the other
recoverable filesystem entries at
`/var/lib/hackerai-migration/e2b-filesystem.tar.gz` inside the user's Miosa VM.
The original E2B sandbox is retained. This is file preservation, not VM-image or
process migration: custom system tools may need reinstalling. Files in `/root`,
`/tmp`, `/opt`, and system configuration are available in the archive, not
automatically installed over the Miosa operating system. Do not describe this
as preserving an arbitrary customized runtime unchanged.

## Eligibility and storage contract

The existing paid-plan and Miosa assignment gates still apply. A server request
selected by `miosa_e2b_file_migration_v1` schedules a Trigger task after 20 minutes
and continues using E2B. Scheduling is deduplicated per user/source for one hour.
The worker rechecks the flag, complete cross-cluster inventory, source ownership,
paused lifecycle, region and the exclusive 15-minute activity fence. Source
metadata must match the worker's configured E2B template alias because multiple
environments may share an E2B account. Unknown or other-environment sources are
deferred even if their user ID matches. Multiple
sources, attached volumes, EU/unknown execution, existing Miosa workspaces,
active commands, unsupported mounts, unsupported home entries and links from
home to un-restored paths are deferred. The destination must use the native
`hackerai-tools` template.

The archive includes regular files, hidden/empty files, directories, links,
numeric ownership, modes, extended attributes and tar timestamps. Kernel
`/proc` and `/sys` are excluded. Device nodes and FIFOs are archived as metadata;
no device bytes are read. Runtime sockets under `/run` and `/dev` and in-memory
process/connection state are not restored. Other sockets defer migration.
Captured system journal bytes are retained, but their ongoing changes do not
invalidate the same-source comparison. Certificate/configuration bytes are
never normalized away. Unknown reads and all other detected source changes deny
cutover. The original source remains the recovery copy for runtime state.

Initial limits: 250,000 entries, 12 GiB of regular-file data and a 4 GiB compressed
archive. Archive bytes pass through the worker in 4 MiB chunks without local
disk, object storage or content-bearing task payloads. The worker checks total
size and SHA-256; the destination rechecks archive integrity and the restored
home's content/metadata fingerprint. It verifies the source again, pauses it,
and tests destination pause/resume persistence before committing the destination
ID. Oversized workspaces and insufficient destination storage stay on E2B.
Two jobs may run concurrently. Tasks have a two-hour ceiling and up to three
attempts with backoff; individual filesystem operations and transfers have
shorter limits. A retained checking fence requires recovery before a retry can
proceed.

## Cutover and recovery

Keep the durable Redis fence and deploy fence-aware Ask/Agent workers before
activation. Both providers are unavailable to new application acquisitions while
the copy holds the fence. A request arriving then receives the existing
workspace-recovery error and must retry after migration; no active run is
interrupted to force eligibility. Monitor this user-visible interruption.

Prepared destinations use private, unique migration names, not the normal
workspace name. Failed copies destroy only that prepared destination and remove
their own source staging directory before releasing the fence. Unconfirmed
cleanup, process death or uncertain commit retains the fence for operator
recovery. Never bulk-clear migration records or give them a TTL.

Committed records pin an exact destination ID. Missing or broken destinations
fail safely; neither creation of an empty replacement nor fallback to the stale
E2B copy is permitted. Flag rollback stops new migrations, including in-flight
copies before installation, while migrated users retain Miosa. Legacy committed
empty-migration records remain readable. Cleanup atomically owns the same Redis
key before enumerating either provider, including when no migration existed.
An active checking claim blocks cleanup before enumeration; never revoke it to
force deletion. Concurrent cleanup attempts must retry.

Explicit workspace reset deletes both providers, then clears only its matching
cleanup token. Failed reset restores the prior committed record so it cannot
expose the retained E2B copy. Account deletion retains a non-expiring `deleted`
fence even after partial provider failure, preventing delayed migration jobs
from creating another destination. Failed deletion retains any committed pin so
retries still require both providers; account deletion may retry cleanup under
that fence. Never clear a deleted account's fence to retry a task.

A crashed cleanup retains `cleanup` ownership and any prior committed record
inside it. Stop the cleanup invocation and confirm it cannot resume before
operator recovery. For reset, finish provider deletion or restore the recorded
committed pin; clear the matching cleanup token only after complete deletion.
For account deletion, finish provider cleanup and retain the `deleted` fence.

For a stranded checking record, stop the corresponding Trigger job, confirm the
record token/source and both provider identities, destroy the exact uncommitted
prepared destination and remove the owned source staging directory. Verify no
commit occurred before clearing that exact checking record. A committed or
uncertain migration requires Miosa recovery or a separately verified reverse
transfer. Source retention has no automatic deletion job; establish a retention
policy separately before deleting any retained E2B workspace.

## Rollout and acceptance

PostHog Preview project 401167 uses the independent migration key at 100% for
`hackerai_environment=preview|development`; Production project 144137 starts at
25% for `hackerai_environment=production`, default 0%. Bucketing uses the stable
user ID. Prepare both flags disabled until acceptance. Disable the superseded
empty-migration flag; its baseline tool/configuration is removed.

Before activation, independently verify Vercel, Trigger, PostHog and the proper
Convex account/deployment for each environment. A Vercel Preview URL alone does
not prove the Trigger worker uses Preview configuration. Deploy the new task and
acquisition code, finish older cohort runs, then enable Preview acceptance.
After acceptance, enable the authorized production 25%; increasing it requires
a separate readout and rollout decision. Flag changes affect new acquisitions
and in-flight pre-cutover checks without another deployment.

On the actual Preview URL using disposable paid test accounts:

1. Create an E2B workspace with binary, hidden and empty files, nested folders,
   permissions, internal links and xattrs. Include a file outside home. Run a
   bounded Agent command, allow the idle interval, and run the migration task.
   Verify copied home contents and the outside-home archive entry.
2. Run Agent on Miosa, reload/reconnect and verify the files again. Confirm the
   old E2B ID still exists. Check both the visible response and actual provider.
3. Verify active work, mounted volumes, multiple sources, outside-home links,
   unknown reads and size limits defer migration without changing the source.
4. Exercise corrupted transfer, source changes, interrupted workers, failed
   destination cleanup, lost commit acknowledgement and destination loss. Confirm
   no partial destination or stale E2B copy becomes available.
5. Create a Miosa-only file, disable the flag and simulate acquisition failure.
   The user must stay pinned to the copied destination. Verify explicit reset.

`miosa_e2b_file_migration_checked` reports bounded reason/count/duration fields;
`miosa_e2b_file_migration_exposed` records actual acquisition after cutover.
Neither event contains paths, hashes, filenames, contents or credentials.
Track completed Agent runs after exposure, preservation/reconnect failures,
user interruption, transfer cost and acquisition latency. Ross reviews after
48 hours and at least 100 completed affected runs; low traffic extends review.
Stop new migrations on any integrity/isolation failure or material reliability
regression. Remove the flag only after cohort completion and a stable readout.
