import { captureGoalLifecycle } from "@/lib/goals/analytics";
import { z } from "zod";
import { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { goalServiceKey, goalEnabled, reconcileGoal } from "@/lib/goals/server";
import { getChatById } from "@/lib/db/actions";
import {
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";
import { ChatSDKError } from "@/lib/errors";

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
export async function GET(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    const chatId = req.nextUrl.searchParams.get("chatId");
    const goal = chatId ? await reconcileGoal(chatId, userId) : null;
    return Response.json({
      enabled: await goalEnabled(userId, subscription),
      ...(chatId ? { goal: goal?.deletedAt ? null : goal } : {}),
    });
  } catch (e) {
    return e instanceof ChatSDKError
      ? e.toResponse()
      : Response.json({ message: "Goal access unavailable" }, { status: 503 });
  }
}
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
