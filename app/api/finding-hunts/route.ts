import { NextRequest } from "next/server";
import { z } from "zod";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { phLogger } from "@/lib/posthog/server";
import { isFindingHuntsEnabled } from "@/lib/findings/hunt-policy";
import { getFindingHuntHistory } from "@/lib/findings/hunt-service";
import type { FindingHuntState } from "@/types/finding";

// History-only. Hunts start and save only through the Agent's own tools inside
// a user-sent request, which keep the normal sandbox approval rules.

const findingId = z.string().trim().min(1).max(128);

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export async function GET(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    if (!(await isFindingHuntsEnabled(userId)))
      return json({ enabled: false } satisfies FindingHuntState);
    const id = findingId.safeParse(req.nextUrl.searchParams.get("findingId"));
    if (!id.success) return json({ message: "Invalid finding" }, 400);
    const history = await getFindingHuntHistory({ userId, findingId: id.data });
    if (!history.available)
      return json({ message: "Finding unavailable" }, 404);
    return json({
      enabled: true,
      chat_title: history.finding.chat_title,
      hunts: history.hunts,
    } satisfies FindingHuntState);
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    try {
      phLogger.warn("finding_hunt_history_failed", {
        failure_kind: error instanceof Error ? "error" : "thrown_value",
      });
    } catch {
      // Diagnostics cannot replace the response.
    }
    return json({ message: "Hunt history is unavailable right now." }, 503);
  }
}
