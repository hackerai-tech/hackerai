import { logger, schedules } from "@trigger.dev/sdk";
import {
  isCloudSandboxAutomaticFailoverConfigured,
  recordAwsAccountHealthProbeSuccess,
  recordAwsSandboxAcquisitionFailure,
} from "@/lib/ai/tools/utils/cloud-sandbox-provider-circuit";
import { probeAwsLambdaMicrovmAccountAccess } from "@/lib/ai/tools/utils/aws-lambda-microvm";

export const probeAwsCloudSandboxProviderAccess = schedules.task({
  id: "probe-aws-cloud-sandbox-provider-access",
  cron: "* * * * *",
  queue: {
    name: "aws-cloud-sandbox-provider-health",
    concurrencyLimit: 1,
  },
  ttl: "2m",
  maxDuration: 45,
  retry: { maxAttempts: 1 },
  run: async (_payload, { ctx }) => {
    if (!isCloudSandboxAutomaticFailoverConfigured()) {
      return { status: "skipped" as const };
    }

    try {
      await probeAwsLambdaMicrovmAccountAccess();
      await recordAwsAccountHealthProbeSuccess({ requestId: ctx.run.id });
      return { status: "healthy" as const };
    } catch (error) {
      const result = await recordAwsSandboxAcquisitionFailure(error, {
        requestId: ctx.run.id,
        source: "health_probe",
      });
      logger.warn("AWS Cloud sandbox account probe failed", {
        event: "cloud_sandbox_provider_health_probe_failed",
        provider: "aws-lambda-microvm",
        fallback_provider: "e2b",
        request_id: ctx.run.id,
        failure_class: result.failureClass ?? "unclassified",
        circuit_opened: result.opened,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
      return {
        status: result.opened
          ? ("circuit_opened" as const)
          : ("failed" as const),
        failureClass: result.failureClass,
      };
    }
  },
});
