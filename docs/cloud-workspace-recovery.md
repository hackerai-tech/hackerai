# Cloud workspace recovery boundaries

Cloud execution uses E2B. Existing `cloud_workspace_migration:v1` records still
protect workspace continuity; their namespace must not be deleted or renamed as
part of provider cleanup.

An absent record permits ordinary E2B discovery. A valid `e2b` record pins an
exact destination in its recorded cluster. A missing pinned destination must
fail rather than creating an empty replacement. Unknown legacy provider records,
in-progress cleanup, malformed records, and unavailable Production Redis remain
blocked for operator recovery.

A record with `recoveryPending` can permit execution in its pinned E2B workspace,
but does not establish that earlier files were restored. Account/workspace
cleanup remains blocked until that outstanding recovery is resolved. Do not
clear the record merely because a fresh terminal command succeeds.

Before an operator changes a record, verify the intended environment, ownership,
all retained workspaces and their files, and the exact destination. Pause managed
writers and use compare-and-set ownership so an old worker cannot overwrite the
recovery decision. Keep prior copies until file verification and resumed
execution establish continuity. Repository changes do not delete external
provider data, credentials, or service-side feature flags.
