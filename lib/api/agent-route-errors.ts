import { NextResponse } from "next/server";

import { ChatSDKError } from "@/lib/errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";

const MAX_ERROR_FIELD_LENGTH = 1000;
const MAX_STACK_FIELD_LENGTH = 2000;

type AgentRouteErrorContext = {
  requestId?: string;
  userId?: string;
  chatId?: string;
  runId?: string;
  stage?: string;
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
  action: "start" | "resume" | "cancel" | "status";
  fallbackMessage: string;
  context?: AgentRouteErrorContext;
}) {
  if (error instanceof ChatSDKError) return error.toResponse();

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
      stage: context.stage,
      ...serializeRouteError(error),
    }),
  );
  return new NextResponse(fallbackMessage, { status: 500 });
}
