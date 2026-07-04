import { NextResponse } from "next/server";

import { ChatSDKError } from "@/lib/errors";
import type { AgentApiEndpoint } from "@/lib/api/agent-endpoints";

export function handleAgentRouteError({
  error,
  endpoint,
  action,
  fallbackMessage,
}: {
  error: unknown;
  endpoint: AgentApiEndpoint;
  action: "start" | "resume" | "cancel";
  fallbackMessage: string;
}) {
  if (error instanceof ChatSDKError) return error.toResponse();

  const logSuffix =
    action === "start" ? "failed to trigger task" : `${action} failed`;
  console.error(`[${endpoint}] ${logSuffix}:`, error);
  return new NextResponse(fallbackMessage, { status: 500 });
}
