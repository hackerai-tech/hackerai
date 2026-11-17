import { runs } from "@trigger.dev/sdk";

import { closeAgentApprovalSession } from "@/lib/api/agent-approval-session";
import {
  getActiveTriggerRunsForUser,
  getChatById,
  setActiveTriggerRun,
} from "@/lib/db/actions";
import { listActiveSubagentsForUser } from "@/lib/db/subagents";

/** Provider reads one request may spend; larger sets stay blocked. */
const MAX_RECONCILED_PARENT_RUNS = 5;
const OPERATION_TIMEOUT_MS = 3_000;

// CRASHED is deliberately absent: the status route owns its output replay, and
// clearing the reference here would lose that recoverable progress.
const CLEARABLE_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

type ParentRunReference = Awaited<
  ReturnType<typeof getActiveTriggerRunsForUser>
>["runs"][number];

const withTimeout = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Agent reconciliation operation deadline")),
          OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const readAgentRuns = async (userId: string) => {
  const [parents, children] = await Promise.all([
    getActiveTriggerRunsForUser({ userId }),
    listActiveSubagentsForUser(userId),
  ]);
  return { parents, children };
};

const isIdle = ({
  parents,
  children,
}: Awaited<ReturnType<typeof readAgentRuns>>): boolean =>
  !parents.hasMore &&
  !children.hasMore &&
  parents.runs.length === 0 &&
  children.runs.length === 0;

/**
 * Detaches one parent reference only when Trigger authoritatively reports the
 * run finished for this owner and chat, and the chat still holds exactly this
 * run and Session. Any unknown or failed step leaves the reference in place.
 */
const clearTerminalParentReference = async (
  userId: string,
  { chatId, triggerRunId, approvalSessionId }: ParentRunReference,
): Promise<boolean> => {
  try {
    const run = await withTimeout(
      runs.retrieve(triggerRunId, { retry: { maxAttempts: 1 } }),
    );
    const metadata =
      run.metadata && typeof run.metadata === "object"
        ? (run.metadata as Record<string, unknown>)
        : undefined;
    if (
      !CLEARABLE_TERMINAL_STATUSES.has(run.status) ||
      metadata?.chatId !== chatId ||
      metadata?.userId !== userId
    )
      return false;

    // A successor may have replaced the reference since the list was read.
    const chat = await withTimeout(getChatById({ id: chatId }));
    if (
      !chat ||
      chat.user_id !== userId ||
      chat.active_trigger_run_id !== triggerRunId ||
      chat.active_agent_approval_session_id !== approvalSessionId
    )
      return false;

    await withTimeout(
      closeAgentApprovalSession(approvalSessionId, "agent-run-terminal"),
    );
    const outcome = await withTimeout(
      setActiveTriggerRun({
        chatId,
        triggerRunId: null,
        approvalSessionId: null,
        expectedRunId: triggerRunId,
        ...(approvalSessionId
          ? { expectedApprovalSessionId: approvalSessionId }
          : {}),
        clearApprovalPending: true,
      }),
    );
    if (outcome !== "updated") return false;
    console.info(
      JSON.stringify({
        event: "agent_run_reference_reconciled",
        service: "hackerai-web",
        chat_id: chatId.slice(0, 128),
        user_id: userId.slice(0, 128),
        trigger_run_id: triggerRunId.slice(0, 128),
        run_status: run.status,
      }),
    );
    return true;
  } catch {
    // Missing, slow or failed provider/database responses are not proof.
    return false;
  }
};

/**
 * Reports whether the user still has Agent runs that must block workspace
 * selection, after detaching parent references whose Trigger runs are already
 * terminal. Never cancels a run, replays crash output, or touches child rows.
 */
export async function reconcileActiveAgentRuns(
  userId: string,
): Promise<"idle" | "active"> {
  const initial = await withTimeout(readAgentRuns(userId));
  if (isIdle(initial)) return "idle";
  const { parents, children } = initial;
  // Clearing parents cannot unblock active children or an unbounded set.
  if (
    children.hasMore ||
    children.runs.length > 0 ||
    parents.hasMore ||
    parents.runs.length > MAX_RECONCILED_PARENT_RUNS
  )
    return "active";

  const cleared = await Promise.all(
    parents.runs.map((reference) =>
      clearTerminalParentReference(userId, reference),
    ),
  );
  if (!cleared.every(Boolean)) return "active";
  return isIdle(await withTimeout(readAgentRuns(userId))) ? "idle" : "active";
}
