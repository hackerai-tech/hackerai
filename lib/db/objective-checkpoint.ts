import { phLogger } from "@/lib/posthog/server";
import "server-only";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "./convex-client";
import {
  newObjectiveCheckpoint,
  objectiveCheckpointSchema,
} from "@/lib/chat/objective-checkpoint";
import { ObjectiveCheckpointRuntime } from "@/lib/ai/objective-checkpoint-runtime";

export async function loadObjectiveCheckpoint(args: {
  userId: string;
  chatId: string;
  triggerRunId: string;
  subagentId?: string;
  environment: () => Promise<string>;
  signal: AbortSignal;
  allowFollowUp: boolean;
}) {
  const { environment, signal, allowFollowUp, ...owner } = args;
  const selection = {
    ...owner,
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
  };
  const client = getConvexClient();
  const stored = await client.query(
    api.subagents.getObjectiveCheckpointForBackend,
    selection,
  );
  const state = stored
    ? objectiveCheckpointSchema.parse(JSON.parse(stored))
    : newObjectiveCheckpoint(args.triggerRunId);
  const isNewRun = state.runId !== args.triggerRunId;
  const priorSpendDollars = state.spendDollars;
  if (isNewRun && allowFollowUp && state.unsuccessfulAttempts >= 2) {
    // Only a caller-identified user follow-up replenishes the two-attempt policy.
    // This never replenishes billing, step, provider retry or child resume budgets.
    state.unsuccessfulAttempts = 0;
    state.blocker = undefined;
  }
  state.runId = args.triggerRunId;
  const runtime = new ObjectiveCheckpointRuntime(
    state,
    async (value) => {
      const expectedRevision = value.revision;
      const checkpoint = objectiveCheckpointSchema.parse({
        ...value,
        revision: expectedRevision + 1,
      });
      await client.mutation(api.subagents.saveObjectiveCheckpointForBackend, {
        ...selection,
        checkpoint: JSON.stringify(checkpoint),
        expectedRevision,
      });
      value.revision = checkpoint.revision;
    },
    environment,
    signal,
    (name, fields) =>
      phLogger.event(name, {
        userId: args.userId,
        run_id: args.triggerRunId,
        role: args.subagentId ? "child" : "parent",
        ...fields,
      }),
    priorSpendDollars,
  );
  if (stored) await runtime.reconcile();
  return runtime;
}

export async function objectiveCheckpointEnabledForChild(args: {
  userId: string;
  chatId: string;
  triggerRunId: string;
  subagentId: string;
}) {
  return getConvexClient().query(
    api.subagents.objectiveCheckpointEnabledForChildBackend,
    {
      ...args,
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    },
  );
}
