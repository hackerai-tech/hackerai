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
const SERVICE_UNAVAILABLE_STAGES = [
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
  "read_request",
  "get_chat",
  "retrieve_trigger_run",
  "recover_crashed_trigger_run",
  "clear_uninitialized_terminal_trigger_run",
  "clear_terminal_trigger_run",
  "clear_missing_trigger_run",
] as const;

type AgentRouteErrorContext = {
  requestId?: string;
  userId?: string;
  chatId?: string;
  runId?: string;
  approvalSessionId?: string;
  stage?: string;
  initialPersistenceStep?: InitialChatPersistenceStep;
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
        const type = Object.getOwnPropertyDescriptor(error, "type")?.value;
        const surface = Object.getOwnPropertyDescriptor(
          error,
          "surface",
        )?.value;
        const requestIdKind =
          typeof requestId !== "string" || requestId.length > 256
            ? "unavailable"
            : /^(?:[a-z]{3}[0-9]::){0,3}[a-z0-9]{3,16}-[0-9]{10,17}-[a-f0-9]{8,64}$/.test(
                  requestId,
                )
              ? "vercel"
              : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
                ? "uuid"
                : "unavailable";
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
            error_code:
              ERROR_TYPES.some((value) => value === type) &&
              ERROR_SURFACES.some((value) => value === surface)
                ? `${type}:${surface}`
                : "unrecognized",
            request_id_kind: requestIdKind,
            ...(requestIdKind !== "unavailable"
              ? { request_id: requestId }
              : {}),
          }),
        );
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
