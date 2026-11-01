import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { ChatSDKError } from "@/lib/errors";
import {
  chooseWorkspace,
  workspaceOptions,
  WorkspaceOptionsChanged,
} from "@/lib/ai/tools/utils/cloud-workspace-options";

export const maxDuration = 30;
const bodySchema = z
  .object({
    workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
async function owner(request: NextRequest) {
  const { userId, subscription } = await getUserIDAndPro(request);
  if (subscription === "free") throw new ChatSDKError("forbidden:api");
  if (
    process.env.VERCEL_ENV &&
    process.env.VERCEL_ENV !== process.env.HACKERAI_ENVIRONMENT
  )
    throw new Error("Workspace environment mismatch");
  await assertUserCanMakeCostIncurringRequest(userId);
  return userId;
}
function failure(
  error: unknown,
  operation: "read" | "select",
  userId?: string,
) {
  if (error instanceof ChatSDKError) return error.toResponse();
  console.warn("Cloud workspace options unavailable", {
    event: "cloud_workspace_options_unavailable",
    operation,
    reason:
      error instanceof WorkspaceOptionsChanged
        ? "selection_changed"
        : "dependency_unavailable",
    ...(userId ? { user_id: userId.slice(0, 128) } : {}),
  });
  return json({ status: "unavailable" }, 409);
}
const signalFor = (request: NextRequest) =>
  AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
export async function GET(request: NextRequest) {
  let userId: string | undefined;
  try {
    userId = await owner(request);
    return json(
      await workspaceOptions(
        userId,
        new URL(request.url).searchParams.get("manage") === "1",
        signalFor(request),
      ),
    );
  } catch (error) {
    return failure(error, "read", userId);
  }
}
export async function POST(request: NextRequest) {
  let userId: string | undefined;
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return json({ status: "unavailable" }, 403);
    userId = await owner(request);
    const body = bodySchema.safeParse(await request.json());
    if (!body.success) return json({ status: "unavailable" }, 400);
    return json(
      await chooseWorkspace(
        userId,
        body.data.workspaceId,
        body.data.token,
        signalFor(request),
      ),
    );
  } catch (error) {
    return failure(error, "select", userId);
  }
}
