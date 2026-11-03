import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runs, wait } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById } from "@/lib/db/actions";
import { claimAgentUserWaitReply } from "@/lib/db/agent-user-wait";
import { workos } from "@/app/api/workos";
import { handleAgentRouteError } from "./agent-route-errors";
import type { AgentApiEndpoint } from "./agent-endpoints";

const MAX_REPLY_LENGTH = 20_000;
const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

type ReplyBody = {
  chatId?: unknown;
  runId?: unknown;
  toolCallId?: unknown;
  text?: unknown;
};

type DeliveredReply = {
  chatId: string;
  userId: string;
  runId: string;
  toolCallId: string;
  replyId: string;
  text: string;
};

const matchesDeliveredReply = (
  output: unknown,
  identity: Omit<DeliveredReply, "text">,
): boolean => {
  if (!output || typeof output !== "object") return false;
  const result = output as Record<string, unknown>;
  return (
    result.chatId === identity.chatId &&
    result.userId === identity.userId &&
    result.runId === identity.runId &&
    result.toolCallId === identity.toolCallId &&
    result.replyId === identity.replyId
  );
};

export const createAgentUserReplyPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    let stage = "parse_request";
    let chatId: string | undefined;
    let runId: string | undefined;
    let userId: string | undefined;
    try {
      let body: ReplyBody;
      try {
        body = (await req.json()) as ReplyBody;
      } catch {
        return new NextResponse("Invalid JSON body", { status: 400 });
      }
      if (!body || typeof body !== "object") {
        return new NextResponse("Invalid Agent reply", { status: 400 });
      }
      chatId = typeof body.chatId === "string" ? body.chatId : undefined;
      runId = typeof body.runId === "string" ? body.runId : undefined;
      const toolCallId =
        typeof body.toolCallId === "string" ? body.toolCallId : undefined;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (
        !chatId ||
        chatId.length > 200 ||
        !runId ||
        runId.length > 200 ||
        !toolCallId ||
        toolCallId.length > 200 ||
        !text ||
        text.length > MAX_REPLY_LENGTH
      ) {
        return new NextResponse("Invalid Agent reply", { status: 400 });
      }

      stage = "authenticate";
      const auth = await getUserIDAndPro(req);
      userId = auth.userId;
      if (auth.subscription === "team" && !auth.organizationId) {
        return new NextResponse("Active organization required", {
          status: 403,
        });
      }
      if (auth.organizationId) {
        const memberships =
          await workos.userManagement.listOrganizationMemberships({
            userId,
            organizationId: auth.organizationId,
            statuses: ["active"],
          });
        if (memberships.data.length === 0) {
          return new NextResponse("Active organization membership required", {
            status: 403,
          });
        }
      }

      stage = "authorize_wait";
      const chat = await getChatById({ id: chatId });
      const pending = chat?.active_agent_user_wait;
      if (
        chat?.user_id === userId &&
        chat.active_trigger_run_id === runId &&
        chat.deletion_started_at === undefined &&
        !pending
      ) {
        // The stream can show the tool call before the Convex subscription
        // publishes its wait token. The client may retry the same draft.
        return new NextResponse("Agent is preparing to wait for a reply", {
          status: 425,
        });
      }
      if (
        !chat ||
        chat.user_id !== userId ||
        chat.active_trigger_run_id !== runId ||
        chat.deletion_started_at !== undefined ||
        !pending ||
        pending.runId !== runId ||
        pending.toolCallId !== toolCallId
      ) {
        return new NextResponse("Agent is no longer waiting for this reply", {
          status: 409,
        });
      }

      stage = "verify_run";
      const run = await runs.retrieve(runId);
      const metadata =
        run.metadata && typeof run.metadata === "object"
          ? (run.metadata as Record<string, unknown>)
          : {};
      if (
        TERMINAL_RUN_STATUSES.has(run.status) ||
        metadata.userId !== userId ||
        metadata.chatId !== chatId
      ) {
        return new NextResponse("Agent run is no longer active", {
          status: 409,
        });
      }

      const replyHash = createHash("sha256").update(text).digest("hex");
      const replyId = createHash("sha256")
        .update(`${runId}\0${toolCallId}\0${replyHash}`)
        .digest("hex")
        .slice(0, 32);
      const identity = { chatId, userId, runId, toolCallId, replyId };
      stage = "claim_reply";
      const claim = await claimAgentUserWaitReply({
        ...identity,
        replyHash,
      });
      if (claim !== "claimed" && claim !== "duplicate") {
        return new NextResponse("Agent reply is no longer available", {
          status: 409,
        });
      }

      stage = "deliver_reply";
      const token = await wait.retrieveToken<DeliveredReply>(pending.tokenId);
      if (token.status === "COMPLETED") {
        return matchesDeliveredReply(token.output, identity)
          ? NextResponse.json({ accepted: true, runId })
          : new NextResponse("Agent received a different reply", {
              status: 409,
            });
      }
      if (token.status !== "WAITING") {
        return new NextResponse("Agent wait has expired", { status: 409 });
      }
      await wait.completeToken(pending.tokenId, {
        ...identity,
        text,
      } satisfies DeliveredReply);
      return NextResponse.json({ accepted: true, runId });
    } catch (error) {
      return handleAgentRouteError({
        error,
        endpoint,
        action: "reply",
        fallbackMessage: "Failed to send Agent reply. Retry the same message.",
        context: { stage, userId, chatId, runId },
      });
    }
  };
