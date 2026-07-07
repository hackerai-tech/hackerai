import { NextRequest, NextResponse } from "next/server";
import { ApiError, runs } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";

type AgentStatusRequestBody = {
  chatId?: unknown;
  runId?: unknown;
};

type TriggerRunStatus = {
  metadata?: unknown;
  status?: string;
};

const MISSING_RUN_STATUSES = new Set([400, 404, 410, 422]);

const isMissingTriggerRunError = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status !== undefined &&
  MISSING_RUN_STATUSES.has(error.status);

const runBelongsToChatOwner = (
  run: TriggerRunStatus,
  expected: { chatId: string; userId: string },
): boolean => {
  if (!run.metadata || typeof run.metadata !== "object") return false;
  const metadata = run.metadata as Record<string, unknown>;
  return (
    metadata.chatId === expected.chatId && metadata.userId === expected.userId
  );
};

export const createAgentStatusPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    let userId: string | undefined;
    let chatId: string | undefined;
    let runId: string | undefined;
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-vercel-id") ??
      undefined;

    try {
      let body: AgentStatusRequestBody;
      try {
        body = (await req.json()) as AgentStatusRequestBody;
      } catch {
        return new NextResponse("Invalid JSON body", { status: 400 });
      }

      chatId = typeof body.chatId === "string" ? body.chatId : undefined;
      runId = typeof body.runId === "string" ? body.runId : undefined;

      if (!chatId) {
        return new NextResponse("chatId required", { status: 400 });
      }
      if (!runId) {
        return new NextResponse("runId required", { status: 400 });
      }

      const authContext = await getUserIDAndPro(req);
      userId = authContext.userId;

      const run = (await runs.retrieve(runId)) as TriggerRunStatus;
      if (!runBelongsToChatOwner(run, { chatId, userId })) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      return NextResponse.json({ status: run.status });
    } catch (error) {
      if (isMissingTriggerRunError(error)) {
        return new NextResponse("Run not found", { status: 404 });
      }

      return handleAgentRouteError({
        error,
        endpoint,
        action: "status",
        fallbackMessage: "Failed to retrieve run status",
        context: {
          requestId,
          userId,
          chatId,
          runId,
        },
      });
    }
  };
