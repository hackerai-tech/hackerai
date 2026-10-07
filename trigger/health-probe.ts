import { task } from "@trigger.dev/sdk";
import { createHash } from "node:crypto";

// Measures dispatch and worker execution in the same deployment as Agent runs.
// No model, sandbox, customer data, or retries; it is not a full Agent journey.
export const healthProbeTask = task({
  id: "agent-health-probe",
  machine: { preset: "small-1x" },
  maxDuration: 10,
  retry: { maxAttempts: 1 },
  run: async (payload: {
    nonce: string;
    includeRuntimeIdentity?: boolean;
  }) => ({
    nonce: payload.nonce,
    ...(payload.includeRuntimeIdentity === true && {
      runtimeIdentity: {
        convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL ?? null,
        posthogKeyFingerprint: process.env.NEXT_PUBLIC_POSTHOG_KEY
          ? createHash("sha256")
              .update(process.env.NEXT_PUBLIC_POSTHOG_KEY)
              .digest("hex")
          : null,
      },
    }),
  }),
});
