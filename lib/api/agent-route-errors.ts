import { NextResponse } from "next/server";

import { ChatSDKError, ERROR_TYPES, ERROR_SURFACES } from "@/lib/errors";
import {
  AGENT_API_ENDPOINT,
  LEGACY_AGENT_API_ENDPOINT,
  type AgentApiEndpoint,
} from "@/lib/api/agent-endpoints";
import type { InitialChatPersistenceStep } from "@/lib/db/actions";

const MAX_ERROR_FIELD_LENGTH = 1000;
const MAX_STACK_FIELD_LENGTH = 2000;

// These stages belong to the start/status callers, not arbitrary request data.
const AGENT_START_STAGES = [
  "parse_request",
  "authenticate",
  "access_gates",
  "workspace_routing",
  "load_chat_and_preferences",
  "reconcile_goal",
  "resolve_execution_context",
  "prepare_desktop_attachments",
  "persist_user_message",
  "create_idempotency_key",
  "sessions.start",
  "tasks.trigger",
  "create_tokens_and_associate_run",
] as const;

const SERVICE_UNAVAILABLE_STAGES = [
  ...AGENT_START_STAGES,
  "read_request",
  "get_chat",
  "retrieve_trigger_run",
  "recover_crashed_trigger_run",
  "clear_uninitialized_terminal_trigger_run",
  "clear_terminal_trigger_run",
  "clear_missing_trigger_run",
] as const;

/** Existing Agent start callsites that may deny a request; not policy reasons. */
const AGENT_START_GUARD_BOUNDARIES = [
  "account_access_gate",
  "regional_subscription_gate",
  "free_agent_sandbox_gate",
  "persistent_goal_request_gate",
  "chat_owner_gate",
] as const;
export type AgentStartGuardBoundary =
  (typeof AGENT_START_GUARD_BOUNDARIES)[number];

type AgentRouteErrorContext = {
  requestId?: string;
  userId?: string;
  chatId?: string;
  runId?: string;
  approvalSessionId?: string;
  stage?: string;
  initialPersistenceStep?: InitialChatPersistenceStep;
  guardBoundary?: AgentStartGuardBoundary;
};

const getRequestIdKind = (requestId: unknown) =>
  typeof requestId !== "string" || requestId.length > 256
    ? "unavailable"
    : /^(?:[a-z]{3}[0-9]::){0,3}[a-z0-9]{3,16}-[0-9]{10,17}-[a-f0-9]{8,64}$/.test(
          requestId,
        )
      ? "vercel"
      : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
        ? "uuid"
        : "unavailable";

const getTypedErrorCode = (error: ChatSDKError) => {
  const type = Object.getOwnPropertyDescriptor(error, "type")?.value;
  const surface = Object.getOwnPropertyDescriptor(error, "surface")?.value;
  return ERROR_TYPES.some((value) => value === type) &&
    ERROR_SURFACES.some((value) => value === surface)
    ? `${type}:${surface}`
    : "unrecognized";
};

// The marker records which existing callsite was active, never why it denied.
const getGuardBoundary = (context: AgentRouteErrorContext) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      context,
      "guardBoundary",
    );
    if (
      !descriptor ||
      ("value" in descriptor && descriptor.value === undefined)
    )
      return "other";
    return "value" in descriptor &&
      AGENT_START_GUARD_BOUNDARIES.some((value) => value === descriptor.value)
      ? (descriptor.value as AgentStartGuardBoundary)
      : "unreadable";
  } catch {
    return "unreadable";
  }
};

/** A receipt for this returned 403, not proof the denial was legitimate. */
const logAgentStartForbidden = (
  error: ChatSDKError,
  endpoint: AgentApiEndpoint,
  context: AgentRouteErrorContext,
) => {
  const stage = Object.getOwnPropertyDescriptor(context, "stage")?.value;
  const requestId = Object.getOwnPropertyDescriptor(
    context,
    "requestId",
  )?.value;
  const requestIdKind = getRequestIdKind(requestId);
  const build = process.env.VERCEL_GIT_COMMIT_SHA;
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "agent_start_forbidden_context",
      service: "hackerai-web",
      agent_start_forbidden_diagnostic_version: 1,
      http_status: 403,
      endpoint,
      action: "start",
      stage: AGENT_START_STAGES.some((value) => value === stage)
        ? stage
        : "unknown",
      guard_boundary: getGuardBoundary(context),
      error_code: getTypedErrorCode(error),
      request_id_kind: requestIdKind,
      ...(requestIdKind !== "unavailable" ? { request_id: requestId } : {}),
      ...(typeof build === "string" && /^[a-f0-9]{40}$/i.test(build)
        ? { web_build_commit: build.toLowerCase() }
        : {}),
    }),
  );
};

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

const getErrorStringField = (
  error: unknown,
  key: string,
): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const getErrorNumberField = (
  error: unknown,
  key: string,
): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const serializeRouteError = (error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();

  return {
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: truncate(message, MAX_ERROR_FIELD_LENGTH),
    error_status:
      getErrorNumberField(error, "status") ??
      getErrorNumberField(error, "statusCode"),
    error_code: getErrorStringField(error, "code"),
    error_stack:
      error instanceof Error && error.stack
        ? truncate(error.stack, MAX_STACK_FIELD_LENGTH)
        : undefined,
  };
};

/** Preserve typed responses; optional 503/403 receipts must never change delivery. */
export function handleAgentRouteError({
  error,
  endpoint,
  action,
  fallbackMessage,
  context = {},
}: {
  error: unknown;
  endpoint: AgentApiEndpoint;
  action: "start" | "resume" | "cancel" | "status" | "approve" | "reply";
  fallbackMessage: string;
  context?: AgentRouteErrorContext;
}) {
  if (error instanceof ChatSDKError) {
    const response = error.toResponse();
    try {
      if (
        (action === "start" || action === "status") &&
        (endpoint === AGENT_API_ENDPOINT ||
          endpoint === LEGACY_AGENT_API_ENDPOINT) &&
        response.status === 503
      ) {
        const stage = Object.getOwnPropertyDescriptor(context, "stage")?.value;
        const requestId = Object.getOwnPropertyDescriptor(
          context,
          "requestId",
        )?.value;
        const requestIdKind = getRequestIdKind(requestId);
        // A receipt for this returned response, not proof of provider cause,
        // request execution elsewhere, persistence or customer recovery.
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            event: "agent_route_service_unavailable",
            service: "hackerai-web",
            agent_route_error_diagnostic_version: 1,
            http_status: 503,
            endpoint,
            action,
            stage: SERVICE_UNAVAILABLE_STAGES.some((value) => value === stage)
              ? stage
              : "unknown",
            error_code: getTypedErrorCode(error),
            request_id_kind: requestIdKind,
            ...(requestIdKind !== "unavailable"
              ? { request_id: requestId }
              : {}),
          }),
        );
      } else if (
        action === "start" &&
        (endpoint === AGENT_API_ENDPOINT ||
          endpoint === LEGACY_AGENT_API_ENDPOINT) &&
        response.status === 403
      ) {
        logAgentStartForbidden(error, endpoint, context);
      }
    } catch {
      // Optional diagnostics must preserve the exact original response.
    }
    return response;
  }

  const logSuffix =
    action === "start" ? "failed to trigger task" : `${action} failed`;
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "agent_route_failed",
      service: "hackerai-web",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      endpoint,
      action,
      log_message: `[${endpoint}] ${logSuffix}`,
      request_id: context.requestId,
      user_id: context.userId,
      chat_id: context.chatId,
      trigger_run_id: context.runId,
      approval_session_id: context.approvalSessionId,
      stage: context.stage,
      ...(context.stage === "persist_user_message" &&
      context.initialPersistenceStep
        ? { initial_persistence_step: context.initialPersistenceStep }
        : {}),
      ...serializeRouteError(error),
    }),
  );
  return NextResponse.json(
    {
      code: "bad_request:api",
      message: "Something went wrong. Please try again later.",
      cause: fallbackMessage,
    },
    { status: 500 },
  );
}
