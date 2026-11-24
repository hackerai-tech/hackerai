/**
 * Mid-run steering: a follow-up the user sends while an Agent run is working.
 * The running agent reads it before its next model step instead of the user
 * waiting for the run to finish (queue) or cancelling it (stop and send).
 *
 * The transcript stores a steer as a data part inside the assistant message at
 * the point the agent read it. Model history turns that part back into a user
 * message, so later turns see the same order the agent did.
 */

export const AGENT_STEER_PART_TYPE = "data-agent-steer";
export const AGENT_STEER_MAX_TEXT_LENGTH = 20_000;
export const AGENT_STEER_MAX_PENDING = 10;

export type AgentSteer = { id: string; text: string };

export type AgentSteerPart = {
  type: typeof AGENT_STEER_PART_TYPE;
  id: string;
  data: AgentSteer;
};

export const isValidAgentSteerId = (id: string) =>
  /^[A-Za-z0-9_-]{1,64}$/.test(id);

export const createAgentSteerPart = (steer: AgentSteer): AgentSteerPart => ({
  type: AGENT_STEER_PART_TYPE,
  id: steer.id,
  data: { id: steer.id, text: steer.text },
});

export const isAgentSteerPart = (part: unknown): part is AgentSteerPart => {
  if (!part || typeof part !== "object") return false;
  const candidate = part as { type?: unknown; data?: unknown };
  if (candidate.type !== AGENT_STEER_PART_TYPE) return false;
  const data = candidate.data as Partial<AgentSteer> | undefined;
  return typeof data?.id === "string" && typeof data.text === "string";
};

type MessageWithParts = { id?: string; role: string; parts?: unknown[] };

/**
 * Split each assistant message at its steer parts so model history reads
 * `assistant → user (steer) → assistant`. Only for model conversion: the
 * fragments share the saved message's ID, so they must never be persisted or
 * used for ID-based bookkeeping such as summary cutoffs.
 */
export function splitAgentSteerMessages<T extends MessageWithParts>(
  messages: T[],
): T[] {
  if (
    !messages.some(
      (message) =>
        message.role === "assistant" && message.parts?.some(isAgentSteerPart),
    )
  )
    return messages;
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !message.parts?.some(isAgentSteerPart))
      return [message];
    const result: T[] = [];
    let current: unknown[] = [];
    const pushAssistant = () => {
      if (current.length === 0) return;
      result.push({ ...message, parts: current });
      current = [];
    };
    for (const part of message.parts) {
      if (!isAgentSteerPart(part)) {
        current.push(part);
        continue;
      }
      pushAssistant();
      result.push({
        ...message,
        role: "user",
        parts: [{ type: "text", text: part.data.text }],
      } as T);
    }
    pushAssistant();
    return result;
  });
}

const toolCallIdOf = (part: unknown) =>
  part && typeof part === "object"
    ? (part as { toolCallId?: unknown }).toolCallId
    : undefined;

/**
 * Place each steer after the tool call the agent had just finished when it
 * read the steer, before the next step. Without that anchor in this message
 * (read before any output, or a retry replaced the earlier output), the steer
 * precedes the response it influenced.
 */
export function insertAgentSteerParts<T extends { parts: unknown[] }>(
  message: T,
  steers: Array<{ steer: AgentSteer; afterToolCallId?: string }>,
): T {
  if (steers.length === 0) return message;
  const parts = message.parts.filter(
    (part) =>
      !isAgentSteerPart(part) ||
      !steers.some(({ steer }) => steer.id === part.data.id),
  );
  let leading = 0;
  for (const { steer, afterToolCallId } of steers) {
    const anchor =
      afterToolCallId === undefined
        ? -1
        : parts.findLastIndex((part) => toolCallIdOf(part) === afterToolCallId);
    let index: number;
    if (anchor === -1) {
      index = leading++;
    } else {
      const nextStep = parts.findIndex(
        (part, i) =>
          i > anchor && (part as { type?: unknown })?.type === "step-start",
      );
      // Steers read at the same boundary keep their order: each insertion
      // moves that step-start (or the end) past the earlier steer.
      index = nextStep === -1 ? parts.length : nextStep;
    }
    parts.splice(index, 0, createAgentSteerPart(steer));
  }
  return { ...message, parts };
}

/** A run's view of the steers sent to it; see `createAgentSteerInbox`. */
export type AgentSteerInbox = {
  /** Steers sent since the last claim. Never throws; failures keep them unread. */
  claim(): Promise<AgentSteer[]>;
  /** Every steer this run has read, in the order it read them. */
  delivered(): AgentSteer[];
};

/**
 * One inbox per run keeps read steers across provider retries, which replay
 * them like browser handoff notes. The store returns every steer the run has
 * claimed, so one from a lost response arrives on the next claim. An
 * unavailable store must not fail a step: unread steers stay pending, and the
 * client queues them after the run.
 */
export function createAgentSteerInbox({
  claim,
  onError,
}: {
  claim: () => Promise<AgentSteer[]>;
  onError?: (error: unknown) => void;
}): AgentSteerInbox {
  const delivered: AgentSteer[] = [];
  return {
    async claim() {
      try {
        const claimed = (await claim()).filter(
          (steer) => !delivered.some((existing) => existing.id === steer.id),
        );
        delivered.push(...claimed);
        return claimed;
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // Reporting must not turn an unavailable inbox into a failed step.
        }
        return [];
      }
    },
    delivered: () => [...delivered],
  };
}
