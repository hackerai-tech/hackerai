import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import type { EvidenceVerification } from "@/lib/ai/subagents/contracts";
import type { AgentRetestEnvironment } from "./agent-retest-service";
import type { HuntCandidate, HuntCompletion } from "./variant-hunt";

const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;

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
export function getFindingHuntHistory({
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
  return getConvexClient().query(api.findingHunts.getHistoryForBackend, {
    serviceKey: serviceKey(),
    userId,
    findingId,
    ...(chatId !== undefined && { chatId }),
    ...(limit !== undefined && { limit }),
  });
}

/** Provenance comes from the server-side tool context, never from the model. */
export function startFindingHunt({
  expectedUpdatedAt,
  ...ids
}: Provenance & { expectedUpdatedAt: number }) {
  return getConvexClient().mutation(api.findingHunts.startForBackend, {
    ...provenance(ids),
    expectedUpdatedAt,
  });
}

export function recordFindingHuntCandidate({
  candidate,
  retainedEvidenceRefs,
  evidenceVerification,
  environment,
  ...ids
}: Provenance & {
  candidate: HuntCandidate;
  retainedEvidenceRefs: string[];
  evidenceVerification?: EvidenceVerification;
  environment?: AgentRetestEnvironment;
}) {
  return getConvexClient().mutation(
    api.findingHunts.recordCandidateForBackend,
    {
      ...provenance(ids),
      candidate,
      retainedEvidenceRefs,
      ...(evidenceVerification && { evidenceVerification }),
      ...(environment && { environment }),
    },
  );
}

export function completeFindingHunt({
  completion,
  environment,
  ...ids
}: Provenance & {
  completion: HuntCompletion;
  environment?: AgentRetestEnvironment;
}) {
  return getConvexClient().mutation(api.findingHunts.completeForBackend, {
    ...provenance(ids),
    summary: completion.summary,
    limitations: completion.limitations,
    ...(environment && { environment }),
  });
}
