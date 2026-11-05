import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { ChatSDKError } from "@/lib/errors";
import {
  selectWorkspaceRegion,
  workspaceRegionView,
} from "@/lib/ai/tools/utils/cloud-workspace-selection";

export const maxDuration = 30;
const bodySchema = z
  .object({
    region: z.enum(["us-east-1", "eu-central-1"]),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
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
function failure(error: unknown) {
  return error instanceof ChatSDKError
    ? error.toResponse()
    : json({ status: "unavailable" }, 409);
}
export async function GET(request: NextRequest) {
  try {
    return json(await workspaceRegionView(await owner(request)));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return json({ status: "unavailable" }, 403);
    const userId = await owner(request);
    const body = bodySchema.safeParse(await request.json());
    if (!body.success) return json({ status: "unavailable" }, 400);
    return json(
      await selectWorkspaceRegion(userId, body.data.region, body.data.token),
    );
  } catch (error) {
    return failure(error);
  }
}
