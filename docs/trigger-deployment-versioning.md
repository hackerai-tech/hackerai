# Agent deployment versioning

Vercel and Trigger deploy separately. Use Trigger's version skew protection to
pin each Agent run to the worker built from the app's commit. The GitHub/Vercel
integration must build every deployed commit, including commits that only change
the UI; otherwise runs wait for an external deployment ID that never arrives.

Keep the SDK and CLI on matching versions that support external deployment IDs
(4.5.12 or later). Enable `TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION=1` and
Vercel's system environment variables so `VERCEL_GIT_COMMIT_SHA` is available
at runtime. The Trigger integration labels worker builds with that same SHA.
For other hosts, supply the matching `TRIGGER_EXTERNAL_DEPLOYMENT_ID` explicitly.

Approval Sessions include that deployment identity in their deduplication key
and pass it in `triggerConfig.externalDeploymentId`. Production refuses to start
an approval Session without a deployment pin. Existing Sessions and in-flight
runs retain their original worker; a new release does not migrate their state.

## Migrating from legacy atomic deployments

1. Verify the designated Preview Convex, Vercel, and Trigger identities separately.
   Submit both a full-access Agent request and an approval-mode request through
   the Preview app. Confirm their run versions belong to the Preview worker built
   from that app's commit, and exercise approval, cancellation, and reload.
2. Deploy the compatible approval-route code to Production before removing the
   old pin. While `TRIGGER_VERSION` exists, it takes precedence over commit-based
   pinning, including in the approval route.
3. Turn off the legacy **Atomic deployments** option in Trigger's Vercel
   integration. Remove **Production's** `TRIGGER_VERSION` and retain Vercel's
   **Auto-assign Custom Production Domains** setting. Do not copy a Production
   version or credential into Preview.
4. Deploy a new commit. Redeploying the same SHA can reuse its existing Trigger
   worker without rebuilding it, so it cannot verify changed worker build inputs.
5. Through `hackerai.co`, repeat both Agent requests and confirm they use the
   matching Production worker. Check Vercel's custom-domain mapping and Trigger's
   Current marker independently; one service's promotion does not prove the other.

For rollback, restore the previous compatible app and its verified worker pin
together. Do not point new approval-protocol code at an arbitrary older worker.

See [Trigger's migration and precedence documentation](https://trigger.dev/docs/deployment/atomic-deployment#legacy-atomic-deployments).
