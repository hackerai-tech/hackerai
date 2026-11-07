import { withServiceQueryRecovery } from "@/lib/db/service-query-recovery.node";
import { captureGoalLifecycle } from "@/lib/goals/analytics";
import { z } from "zod";
import { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { goalServiceKey, reconcileGoal } from "@/lib/goals/server";
import { getChatById } from "@/lib/db/actions";
import {
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";
import { ChatSDKError } from "@/lib/errors";
import { ConvexError } from "convex/values";
import { phLogger } from "@/lib/posthog/server";

const controlRequest = z.discriminatedUnion("action", [
  z.object({
    chatId: z.string().trim().min(1).max(128),
    action: z.enum(["pause", "stop", "clear"]),
    generation: z.number().int().nonnegative().optional(),
  }),
  z.object({
    chatId: z.string().trim().min(1).max(128),
    action: z.literal("update"),
    generation: z.number().int().nonnegative(),
    objective: z.string().trim().min(1).max(4000),
    criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(8),
    verificationCommand: z.string().max(2000).optional(),
    constraints: z.string().max(2000).optional(),
    boundaries: z.string().max(2000).optional(),
    stopWhen: z.string().max(2000).optional(),
  }),
]);
export const maxDuration = 30;
/** Own goal-read recovery until the status response finishes, separately from controls. */
async function handleGet(req: NextRequest) {
  let failureStage: "auth_lookup" | "goal_reconciliation" = "auth_lookup";
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    failureStage = "goal_reconciliation";
    const chatId = req.nextUrl.searchParams.get("chatId");
    const goal = chatId ? await reconcileGoal(chatId, userId) : null;
    return Response.json({
      enabled: subscription !== "free",
      ...(chatId ? { goal: goal?.deletedAt ? null : goal } : {}),
    });
  } catch (e) {
    if (e instanceof ChatSDKError) return e.toResponse();
    let failureKind = "thrown_value";
    let requestId = "none";
    try {
      failureKind =
        e instanceof TypeError
          ? "type_error"
          : e instanceof ConvexError
            ? "convex_error"
            : e instanceof Error
              ? "other_error"
              : "thrown_value";
      if (e && typeof e === "object") {
        // Inspect data properties only; never emit private error/goal contents.
        if (
          Object.getOwnPropertyDescriptor(e, "data")?.value ===
          "Goal chat unavailable"
        )
          failureKind = "goal_chat_unavailable";
        const message = Object.getOwnPropertyDescriptor(e, "message")?.value;
        if (typeof message === "string" && message.length <= 4096)
          requestId =
            message
              .match(/\[Request ID:\s*([a-f0-9]{16})\]/i)?.[1]
              .toLowerCase() ?? "none";
      }
    } catch {
      failureKind = "unreadable_error";
    }
    try {
      phLogger.warn("agent_goal_status_unavailable", {
        diagnostic_version: 1,
        failure_stage: failureStage,
        failure_kind: failureKind,
        convex_request_id: requestId,
      });
    } catch {
      // Diagnostics must not replace the existing response or retry the operation.
    }
    return Response.json(
      { message: "Goal access unavailable" },
      { status: 503 },
    );
  }
}
export const GET = withServiceQueryRecovery(handleGet);

export async function POST(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    const parsed = controlRequest.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return Response.json(
        { message: "Invalid goal control request" },
        { status: 400 },
      );
    const body = parsed.data;
    const chat = await getChatById({ id: body.chatId });
    if (!chat || chat.user_id !== userId)
      return Response.json({ message: "Chat unavailable" }, { status: 403 });
    const { action, ...fields } = body;
    const goal =
      action === "update"
        ? await getConvexClient().mutation(api.agentGoals.update, {
            serviceKey: goalServiceKey(),
            userId,
            ...(fields as Extract<typeof body, { action: "update" }>),
          })
        : await getConvexClient().mutation(api.agentGoals.control, {
            serviceKey: goalServiceKey(),
            userId,
            chatId: body.chatId,
            action,
            generation: body.generation,
          });
    if (goal.activeRunId) {
      await closeAgentApprovalSession(
        chat.active_agent_approval_session_id,
        "goal-user-control",
      );
      await cancelAgentTriggerRun(goal.activeRunId);
    }
    await captureGoalLifecycle(
      action === "update" ? "update" : action,
      { userId, chatId: body.chatId, runId: goal.activeRunId },
      goal,
    );
    return Response.json({ state: goal.state, generation: goal.generation });
  } catch (e) {
    return e instanceof ChatSDKError
      ? e.toResponse()
      : Response.json(
          {
            message:
              "Goal control could not finish. Reload to check saved state.",
          },
          { status: 503 },
        );
  }
}
