import { NextRequest, NextResponse } from "next/server";
import { runs, sessions } from "@trigger.dev/sdk";

import { workos } from "@/app/api/workos";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { signAgentToolApprovalInput } from "@/lib/chat/agent-approval-authorization";
import {
  AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
  type AgentToolApprovalGrantKind,
  type UnsignedAgentToolApprovalInputRecord,
} from "@/types";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";
import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import {
  AGENT_APPROVAL_PROTOCOL_VERSION,
  clearTemporaryAgentApprovalRefreshCookie,
  getTemporaryAgentApprovalRefreshHandle,
  setTemporaryAgentApprovalRefreshCookie,
} from "@/lib/api/agent-approval-session";

type ApprovalDecisionValue = {
  type: "agent-tool-approval";
  approvalId: string;
  toolCallId: string;
  decision: "approve" | "deny";
  grant: "full_access" | "target_prefix";
  targetPrefix?: string;
  targetKind?: AgentToolApprovalGrantKind;
  message?: string;
  at?: number;
};

type ApprovalRequestBody = {
  chatId?: unknown;
  approvalSessionId?: unknown;
  partId?: unknown;
  value?: unknown;
};

type TriggerRunSnapshot = {
  status?: string;
  metadata?: unknown;
};

type TriggerSessionSnapshot = {
  currentRunId?: string | null;
  closedAt?: Date | null;
};

const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

const APPROVAL_TARGET_KINDS = new Set<AgentToolApprovalGrantKind>([
  "terminal_command",
  "terminal_interaction",
  "file_change",
]);

const parseApprovalDecision = (
  value: unknown,
): ApprovalDecisionValue | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.type !== "agent-tool-approval" ||
    typeof record.approvalId !== "string" ||
    typeof record.toolCallId !== "string" ||
    (record.decision !== "approve" && record.decision !== "deny") ||
    (record.grant !== "full_access" && record.grant !== "target_prefix") ||
    (record.targetPrefix !== undefined &&
      typeof record.targetPrefix !== "string") ||
    (record.targetKind !== undefined &&
      (typeof record.targetKind !== "string" ||
        !APPROVAL_TARGET_KINDS.has(
          record.targetKind as AgentToolApprovalGrantKind,
        ))) ||
    (record.message !== undefined && typeof record.message !== "string") ||
    (record.at !== undefined &&
      (typeof record.at !== "number" || !Number.isFinite(record.at)))
  ) {
    return null;
  }

  return {
    type: "agent-tool-approval",
    approvalId: record.approvalId,
    toolCallId: record.toolCallId,
    decision: record.decision,
    grant: record.grant,
    ...(record.targetPrefix ? { targetPrefix: record.targetPrefix } : {}),
    ...(record.targetKind
      ? { targetKind: record.targetKind as AgentToolApprovalGrantKind }
      : {}),
    ...(record.message ? { message: record.message } : {}),
    ...(typeof record.at === "number" ? { at: record.at } : {}),
  };
};

const getMetadata = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const hasActiveOrganizationMembership = async ({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}): Promise<boolean> => {
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    organizationId,
    statuses: ["active"],
  });
  return memberships.data.length > 0;
};

export const createAgentApprovalPost =
  ({ endpoint }: { endpoint: AgentApiEndpoint }) =>
  async (req: NextRequest) => {
    let stage = "parse_request";
    let userId: string | undefined;
    let chatId: string | undefined;
    let runId: string | undefined;
    let approvalSessionId: string | undefined;

    try {
      let body: ApprovalRequestBody;
      try {
        body = (await req.json()) as ApprovalRequestBody;
      } catch {
        return new NextResponse("Invalid JSON body", { status: 400 });
      }

      chatId = typeof body.chatId === "string" ? body.chatId : undefined;
      approvalSessionId =
        typeof body.approvalSessionId === "string"
          ? body.approvalSessionId
          : undefined;
      const partId = typeof body.partId === "string" ? body.partId : undefined;
      const decision = parseApprovalDecision(body.value);
      if (!chatId || !approvalSessionId || !partId || !decision) {
        return new NextResponse("Invalid Agent approval request", {
          status: 400,
        });
      }

      stage = "authenticate";
      const authContext = await getUserIDAndPro(req);
      userId = authContext.userId;
      if (authContext.subscription === "team" && !authContext.organizationId) {
        return new NextResponse("Active organization required", {
          status: 403,
        });
      }
      if (
        authContext.organizationId &&
        !(await hasActiveOrganizationMembership({
          userId,
          organizationId: authContext.organizationId,
        }))
      ) {
        return new NextResponse("Active organization membership required", {
          status: 403,
        });
      }

      stage = "authorize_chat";
      const chat = await getChatById({ id: chatId });
      const temporaryRefresh = chat
        ? null
        : getTemporaryAgentApprovalRefreshHandle({ req, userId, chatId });
      let isTemporary = false;
      if (chat) {
        const pending = chat.active_agent_approval_request;
        if (
          chat.user_id !== userId ||
          chat.active_agent_approval_session_id !== approvalSessionId ||
          !chat.active_trigger_run_id ||
          pending?.approvalId !== decision.approvalId ||
          pending?.toolCallId !== decision.toolCallId
        ) {
          return new NextResponse("Agent approval no longer active", {
            status: 409,
          });
        }
        runId = chat.active_trigger_run_id;
      } else if (
        temporaryRefresh &&
        temporaryRefresh.approvalSessionId === approvalSessionId
      ) {
        runId = temporaryRefresh.runId;
        isTemporary = true;
      } else {
        return new NextResponse("Forbidden", { status: 403 });
      }

      stage = "verify_trigger_state";
      const [run, session] = (await Promise.all([
        runs.retrieve(runId),
        sessions.retrieve(approvalSessionId),
      ])) as [TriggerRunSnapshot, TriggerSessionSnapshot];
      const metadata = getMetadata(run.metadata);
      if (
        (run.status && TERMINAL_RUN_STATUSES.has(run.status)) ||
        session.closedAt ||
        session.currentRunId !== runId ||
        metadata.userId !== userId ||
        metadata.chatId !== chatId ||
        metadata.approvalSessionId !== approvalSessionId ||
        metadata.approvalProtocolVersion !== AGENT_APPROVAL_PROTOCOL_VERSION
      ) {
        const response = new NextResponse("Agent approval no longer active", {
          status: 409,
        });
        if (isTemporary) {
          clearTemporaryAgentApprovalRefreshCookie(response, {
            req,
            userId,
            chatId,
          });
        }
        return response;
      }
      if (
        isTemporary &&
        (metadata.approvalStatus !== "pending" ||
          metadata.approvalId !== decision.approvalId ||
          metadata.approvalToolCallId !== decision.toolCallId)
      ) {
        const response = new NextResponse("Agent approval no longer active", {
          status: 409,
        });
        clearTemporaryAgentApprovalRefreshCookie(response, {
          req,
          userId,
          chatId,
        });
        return response;
      }

      stage = "sign_and_append";
      const issuedAt = Date.now();
      const unsignedInput: UnsignedAgentToolApprovalInputRecord = {
        ...decision,
        protocolVersion: AGENT_TOOL_APPROVAL_PROTOCOL_VERSION,
        authorization: {
          issuedAt,
          userId,
          chatId,
          runId,
          approvalSessionId,
          subscription: authContext.subscription,
          ...(authContext.organizationId
            ? { organizationId: authContext.organizationId }
            : {}),
        },
      };
      const signedInput = signAgentToolApprovalInput(unsignedInput);
      await sessions.open(approvalSessionId).in.send(signedInput, {
        additionalHeaders: { "X-Part-Id": partId },
      });

      const response = NextResponse.json({ accepted: true });
      if (isTemporary) {
        setTemporaryAgentApprovalRefreshCookie(response, {
          req,
          userId,
          chatId,
          runId,
          approvalSessionId,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof ChatSDKError) return error.toResponse();
      return handleAgentRouteError({
        error,
        endpoint,
        action: "approve",
        fallbackMessage: "Failed to send Agent approval",
        context: { stage, userId, chatId, runId, approvalSessionId },
      });
    }
  };
