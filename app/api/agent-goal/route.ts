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

const controlRequest = z.object({
  chatId: z.string().trim().min(1).max(128),
  action: z.enum(["pause", "stop"]),
});
export const maxDuration = 30;
export async function GET(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    const chatId = req.nextUrl.searchParams.get("chatId");
    const goal = chatId ? await reconcileGoal(chatId, userId) : null;
    return Response.json({
      enabled: await goalEnabled(userId, subscription),
      ...(chatId ? { goal } : {}),
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
        { message: "Use pause or stop with a chat ID" },
        { status: 400 },
      );
    const body = parsed.data;
    const chat = await getChatById({ id: body.chatId });
    if (!chat || chat.user_id !== userId)
      return Response.json({ message: "Chat unavailable" }, { status: 403 });
    const goal = await getConvexClient().mutation(api.agentGoals.control, {
      serviceKey: goalServiceKey(),
      chatId: body.chatId,
      userId,
      action: body.action,
    });
    if (goal.activeRunId) {
      await closeAgentApprovalSession(
        chat.active_agent_approval_session_id,
        "goal-user-control",
      );
      await cancelAgentTriggerRun(goal.activeRunId);
    }
    return Response.json({ state: goal.state });
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
