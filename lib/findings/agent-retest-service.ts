import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import type { EvidenceVerification } from "@/lib/ai/subagents/contracts";
import type { AgentRetestResult } from "./agent-retest";

const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;

export type AgentRetestEnvironment = {
  kind: "cloud" | "local" | "desktop";
  name?: string;
};

type Provenance = {
  userId: string;
  chatId: string;
  findingId: string;
  assistantMessageId: string;
  triggerRunId?: string;
};

const provenance = ({ triggerRunId, ...rest }: Provenance) => ({
  serviceKey: serviceKey(),
  ...rest,
  ...(triggerRunId !== undefined && { triggerRunId }),
});

/** Bounded, owner-checked history. Pass chatId to restrict to the source chat. */
export function getAgentRetestHistory({
  userId,
  findingId,
  chatId,
  limit,
}: {
  userId: string;
  findingId: string;
  chatId?: string;
  limit?: number;
}) {
  return getConvexClient().query(api.findingAgentRetests.getHistoryForBackend, {
    serviceKey: serviceKey(),
    userId,
    findingId,
    ...(chatId !== undefined && { chatId }),
    ...(limit !== undefined && { limit }),
  });
}

/** Provenance comes from the server-side tool context, never from the model. */
export function startAgentRetest({
  expectedUpdatedAt,
  ...ids
}: Provenance & { expectedUpdatedAt: number }) {
  return getConvexClient().mutation(api.findingAgentRetests.startForBackend, {
    ...provenance(ids),
    expectedUpdatedAt,
  });
}

export function completeAgentRetest({
  result,
  retainedEvidenceRefs,
  evidenceVerification,
  environment,
  ...ids
}: Provenance & {
  result: AgentRetestResult;
  retainedEvidenceRefs: string[];
  evidenceVerification?: EvidenceVerification;
  environment?: AgentRetestEnvironment;
}) {
  return getConvexClient().mutation(
    api.findingAgentRetests.completeForBackend,
    {
      ...provenance(ids),
      result,
      retainedEvidenceRefs,
      ...(evidenceVerification && { evidenceVerification }),
      ...(environment && { environment }),
    },
  );
}
