import { NextRequest, NextResponse } from "next/server";
import { ConvexError } from "convex/values";
import { randomUUID } from "node:crypto";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getConvexClient } from "@/lib/db/convex-client";
import { canUseSchedules } from "@/lib/schedules/access";
import { validateSchedule } from "@/lib/schedules/recurrence";
import {
  assertUserCanMakeCostIncurringRequest,
  assertUserCanAccessChatHistory,
} from "@/lib/suspensions";
import { ChatSDKError } from "@/lib/errors";
import { reconcileScheduleRuns } from "@/lib/schedules/reconcile";
import { phLogger } from "@/lib/posthog/server";

export const maxDuration = 60;
const serviceKey = () => process.env.CONVEX_SERVICE_ROLE_KEY!;
function errorResponse(error: unknown) {
  if (error instanceof ChatSDKError) return error.toResponse();
  if (error instanceof ConvexError && typeof error.data === "string") {
    return NextResponse.json(
      { message: error.data },
      {
        status:
          error.data === "Schedule not found."
            ? 404
            : error.data.startsWith("Wait a minute")
              ? 429
              : error.data.includes("already has a run")
                ? 409
                : 400,
      },
    );
  }
  console.error("Schedule request failed", {
    errorType: error instanceof Error ? error.name : "unknown",
  });
  return NextResponse.json(
    { message: "Could not update schedules. Please try again." },
    { status: 500 },
  );
}
async function context(req: NextRequest) {
  const identity = await getUserIDAndPro(req);
  await assertUserCanAccessChatHistory(identity.userId);
  const enabled = await canUseSchedules(identity.userId, identity.subscription);
  return {
    ...identity,
    enabled,
    args: { serviceKey: serviceKey(), userId: identity.userId },
  };
}
export async function GET(req: NextRequest) {
  try {
    const ctx = await context(req);
    if (req.nextUrl.searchParams.get("access") === "1")
      return NextResponse.json(
        { enabled: ctx.enabled },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    await reconcileScheduleRuns(ctx.userId).catch((error) => {
      console.error("Schedule reconciliation failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    });
    const schedules = await getConvexClient().query(
      api.schedules.list,
      ctx.args,
    );
    return NextResponse.json(
      { enabled: ctx.enabled, schedules },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(req: NextRequest) {
  try {
    const ctx = await context(req);
    if (!ctx.enabled)
      return NextResponse.json(
        { message: "Schedules are not available for this account yet." },
        { status: 403 },
      );
    await assertUserCanMakeCostIncurringRequest(ctx.userId);
    let definition;
    try {
      definition = validateSchedule(await req.json());
    } catch (error) {
      return NextResponse.json(
        {
          message:
            error instanceof Error ? error.message : "Check your schedule.",
        },
        { status: 400 },
      );
    }
    const id = await getConvexClient().mutation(api.schedules.save, {
      ...ctx.args,
      definition,
      ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
    });
    phLogger.event("agent_schedule_created", {
      userId: ctx.userId,
      timing_type: definition.timing.type,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PATCH(req: NextRequest) {
  try {
    const ctx = await context(req);
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { message: "Invalid request." },
        { status: 400 },
      );
    }
    if (
      !body ||
      typeof body.id !== "string" ||
      !["save", "pause", "resume", "run"].includes(body.action)
    )
      return NextResponse.json(
        { message: "Choose a schedule and action." },
        { status: 400 },
      );
    const id = body.id as Id<"agent_schedules">;
    const db = getConvexClient();
    // Only the safe management actions remain available after disabling the rollout.
    if (body.action !== "pause" && !ctx.enabled)
      return NextResponse.json(
        { message: "Schedules are not available for this account yet." },
        { status: 403 },
      );
    if (body.action === "pause" || body.action === "resume") {
      await db.mutation(api.schedules.setEnabled, {
        ...ctx.args,
        id,
        enabled: body.action === "resume",
      });
    } else if (body.action === "save") {
      let definition;
      try {
        definition = validateSchedule(body.definition);
      } catch (error) {
        return NextResponse.json(
          {
            message:
              error instanceof Error ? error.message : "Check your schedule.",
          },
          { status: 400 },
        );
      }
      await db.mutation(api.schedules.save, {
        ...ctx.args,
        id,
        definition,
        ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
      });
    } else {
      await assertUserCanMakeCostIncurringRequest(ctx.userId);
      const schedule = await db.query(api.schedules.getForDispatch, {
        serviceKey: serviceKey(),
        id,
      });
      if (!schedule || schedule.userId !== ctx.userId)
        return NextResponse.json(
          { message: "Schedule not found." },
          { status: 404 },
        );
      const requestId = randomUUID();
      const receipt = await db.mutation(api.schedules.claim, {
        ...ctx.args,
        id,
        revision: schedule.revision,
        manual: true,
        queueOnly: true,
        dispatcherId: requestId,
        chatId: randomUUID(),
      });
      if (!receipt)
        return NextResponse.json(
          { message: "Schedule changed. Refresh and try again." },
          { status: 409 },
        );
      return NextResponse.json(
        { accepted: true, requestId: receipt.id },
        { status: 202 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(req: NextRequest) {
  try {
    const ctx = await context(req);
    const id = req.nextUrl.searchParams.get("id");
    if (!id)
      return NextResponse.json(
        { message: "Choose a schedule." },
        { status: 400 },
      );
    await getConvexClient().mutation(api.schedules.remove, {
      ...ctx.args,
      id: id as Id<"agent_schedules">,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
