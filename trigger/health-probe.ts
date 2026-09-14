import { task } from "@trigger.dev/sdk";

// Measures dispatch and worker execution in the same deployment as Agent runs.
// No model, sandbox, customer data, or retries; it is not a full Agent journey.
export const healthProbeTask = task({
  id: "agent-health-probe",
  machine: { preset: "small-1x" },
  maxDuration: 10,
  retry: { maxAttempts: 1 },
  run: async (payload: { nonce: string }) => ({ nonce: payload.nonce }),
});
