import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import {
  confirmRecovery,
  recoveryView,
  reopenRecovery,
} from "@/lib/cloud-recovery/service";
import { failConsent } from "@/lib/cloud-recovery/store";
import type { cloudWorkspaceRecoveryTask } from "@/trigger/cloud-workspace-recovery";
export const maxDuration = 60;
const bodySchema = z.union([
  z.object({ token: z.string().uuid(), confirmed: z.boolean() }).strict(),
  z.object({ token: z.string().uuid(), reopen: z.literal(true) }).strict(),
]);
async function owner(request: NextRequest) {
  const { userId, subscription, organizationId } =
    await getUserIDAndPro(request);
  if (subscription === "free") throw new ChatSDKError("forbidden:api");
  if (
    process.env.VERCEL_ENV &&
    process.env.VERCEL_ENV !== process.env.HACKERAI_ENVIRONMENT
  )
    throw new Error("Recovery environment mismatch");
  await assertUserCanMakeCostIncurringRequest(userId);
  return { userId, organizationId };
}
function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function failure(error: unknown) {
  if (error instanceof ChatSDKError) return error.toResponse();
  return json(
    {
      error:
        "Workspace recovery is unavailable. Contact support before trying recovery again.",
    },
    409,
  );
}
export async function GET(request: NextRequest) {
  try {
    return json(await recoveryView((await owner(request)).userId));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      return json({ error: "Invalid origin" }, 403);
    const { userId, organizationId } = await owner(request);
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success)
      return json({ error: "Invalid recovery confirmation" }, 400);
    if ("reopen" in parsed.data) {
      await reopenRecovery(userId, parsed.data.token);
      return json(await recoveryView(userId));
    }
    const consent = await confirmRecovery(
      userId,
      parsed.data.token,
      parsed.data.confirmed,
      organizationId,
    );
    if (consent) {
      try {
        // The task receives only the authenticated owner and consent receipt.
        // A failed dispatch may still have been accepted; never dispatch again.
        await tasks.trigger<typeof cloudWorkspaceRecoveryTask>(
          "cloud-workspace-recovery",
          { userId, token: consent.token, region: consent.target.region },
          {
            idempotencyKey: `cloud-recovery:${consent.token}`,
            idempotencyKeyTTL: "30d",
            region: consent.target.region,
          },
        );
      } catch {
        await failConsent(userId, consent.token).catch(() => {});
        // Atomic settlement revokes an unclaimed token even if dispatch was
        // accepted. Only the resulting verified state may offer fresh approval.
        return json(await recoveryView(userId), 202);
      }
    }
    return json(await recoveryView(userId), 202);
  } catch (error) {
    return failure(error);
  }
}
