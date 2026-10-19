import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { assertTriggerRunRegion } from "@/lib/api/trigger-region";
import { executeCustomerRecovery } from "@/lib/cloud-recovery/service";
const payloadSchema = z
  .object({
    userId: z.string().min(1),
    token: z.string().uuid(),
    region: z.enum(["us-east-1", "us-west-2", "eu-central-1"]),
  })
  .strict();
export const cloudWorkspaceRecoveryTask = task({
  id: "cloud-workspace-recovery",
  machine: { preset: "small-1x" },
  maxDuration: 20 * 60,
  retry: { maxAttempts: 1 },
  run: async (raw: z.infer<typeof payloadSchema>, { ctx }) => {
    const payload = payloadSchema.parse(raw);
    const environment =
      ctx.environment.type === "PREVIEW"
        ? "preview"
        : ctx.environment.type === "PRODUCTION"
          ? "production"
          : null;
    if (!environment || process.env.HACKERAI_ENVIRONMENT !== environment)
      throw new Error("Recovery worker environment mismatch");
    assertTriggerRunRegion({
      requestedRegion: payload.region,
      actualRegion: ctx.run.region,
      environmentType: ctx.environment.type,
    });
    return executeCustomerRecovery(
      payload.userId,
      payload.token,
      payload.region,
    );
  },
});
