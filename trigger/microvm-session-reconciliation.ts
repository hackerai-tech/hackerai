import { logger, schedules } from "@trigger.dev/sdk";
import { reconcileAwsLambdaMicrovmSessions } from "@/lib/ai/tools/utils/aws-lambda-microvm";

/**
 * Backstop for lifecycle callbacks that can be missed when AWS enforces a
 * maximum lifetime or a guest exits before it can notify Convex.
 */
export const reconcileAwsLambdaMicrovmSessionState = schedules.task({
  id: "reconcile-aws-lambda-microvm-session-state",
  cron: "*/10 * * * *",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  maxDuration: 300,
  run: async () => {
    if (!process.env.CONVEX_SERVICE_ROLE_KEY?.trim()) {
      logger.info("AWS Lambda MicroVM reconciliation skipped", {
        event: "cloud_sandbox_state_reconciliation_skipped",
        reason: "convex_service_role_key_missing",
      });
      return { skipped: true as const };
    }

    const summary = await reconcileAwsLambdaMicrovmSessions(100);
    logger.info("AWS Lambda MicroVM reconciliation completed", {
      event: "cloud_sandbox_state_reconciliation_completed",
      ...summary,
    });
    return { skipped: false as const, ...summary };
  },
});
