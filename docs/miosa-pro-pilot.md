# MIOSA fresh-workspace Pro pilot

Owner and rollout/readout decisions: [HAC-78](https://linear.app/hackerai/issue/HAC-78/rollout-miosa-as-primary-cloud-agent-sandbox-with-e2b-fallback).

## Approved scope

**Activation on hold (September 5, 2026):** Production remains at 0%. The
previously working persistent Preview workspace subsequently entered platform
state `error`; reacquisition returned `SANDBOX_BOOT_FAILED`. See the latest
section in [the acceptance record](miosa-acceptance-2026-09-05.md). Passing fresh
creation and short pause/resume tests is insufficient to clear this regression.

- Production: 5% stable user-level candidate assignment.
- Preview/development: 100% candidate assignment for eligible testing.
- New enrollment: authenticated Pro Cloud Agent users, outside Europe, with no
  running or paused E2B workspace in any configured E2B account/cluster.
- No activity event, an idle sandbox, or an old template is **not** proof that
  a workspace has terminated. Read E2B state directly, including all templates.
- Do not delete, pause, migrate, or reset a workspace to make a user eligible.
- Retain E2B fallback and existing region, authorization, and paid-plan gates.

## How it works

`selectCloudSandboxProvider` evaluates the stable user ID, execution environment,
and server-resolved `subscription_tier`. The flag samples candidates; it is not
the authorization or workspace-preservation boundary.

At actual acquisition, an already connected E2B workspace stays on E2B. MIOSA
checks its canonical per-user name before attempting new enrollment. An existing
MIOSA record follows the normal reuse/resume path; the pilot does not erase it
because of an old E2B fallback workspace or a subsequent plan upgrade.

Only a confirmed MIOSA not-found result invokes the new-workspace guard:

1. Require exactly the `pro` plan. Missing plan, Free, Pro+, Ultra, and Team do
   not create a new MIOSA workspace under this pilot.
2. Require the configured default E2B account so missing credentials cannot be
   mistaken for an empty inventory.
3. Query running and paused E2B workspaces by user metadata, without a template
   filter. Check every configured cluster; this is metadata-only discovery, not
   cross-region command execution. Any existing record vetoes enrollment.
4. On missing credentials, failed reads, timeout, or incomplete pagination, stay
   on E2B. Only confirmed absence permits MIOSA's normal idempotent create.

The API inventory is a point-in-time check, not a cross-provider transaction.
Keep assignment stable and do not change provider settings while a user's Agent
run is active. E2B fallback does not copy files or rescue every mid-run failure.

## Flag configuration and release order

Key: `miosa_cloud_sandbox_rollout_v1` in both independent projects:

| Environment         | Project               | Intended candidate percentage |
| ------------------- | --------------------- | ----------------------------: |
| Preview/development | hackerai-dev `401167` |                          100% |
| Production          | HackerAI `144137`     |                            5% |

Filter by the matching `hackerai_environment`; the server enforces Pro eligibility
only for new enrollment. Do not add a changing plan condition that inadvertently
evicts an existing MIOSA assignment after a paid-plan upgrade. Keep the flag key
and distinct ID stable. An explicit E2B override remains an emergency rollback.

These are approved targets, **not evidence that Production is enabled**. Before
activation, merge reviewed code, independently verify Vercel/Trigger/Convex and
PostHog identities, deploy both runtimes, and pass an internal Production smoke
test. Read back each flag and its actual execution environment. Never copy
Preview's percentage or credentials into Production.

## Measurement and rollback

`miosa_cloud_sandbox_enrollment_denied` reports a bounded reason (`not_pro`,
`existing_e2b_workspace`, or `workspace_discovery_unavailable`). A denied candidate
does not emit MIOSA rollout exposure, acquisition failure, or provider fallback.
Real MIOSA acquisition failures retain existing failure/fallback telemetry.

Keep candidate assignment, enrollment, exposure and final provider distinct.
Do not use `$feature_flag_called` alone as actual MIOSA exposure. Compare
completion, latency and cost against comparable fresh Pro E2B workspaces, not
the unfiltered E2B population with older workspaces. Include retry and fallback
costs; testing credits are not production economics.

Review after at least 48 hours and 100 completed eligible runs (extend the window
for low traffic). Stop expansion for data loss, restore/cancellation/output
failures, or material reliability, latency or cost regression. No automatic ramp.

## Verification

- Pro + confirmed empty E2B inventory: may create MIOSA when assigned treatment.
- Pro + running/paused E2B (including old templates/later pages/other configured
  cluster): remains E2B; no workspace is deleted by the enrollment guard.
- Non-Pro + no MIOSA record: no new MIOSA enrollment.
- Existing MIOSA assignment: reuse/resume without applying the new-user gate.
- Failed inventory lookup: E2B; never interpret the failure as an empty list.
- After eligible Preview/Production Agent completion, verify final provider,
  delayed stdout/stderr and exit status, files, PTY, and a follow-up reconnect.
