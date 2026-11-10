import { NextRequest } from "next/server";
import { z } from "zod";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { phLogger } from "@/lib/posthog/server";
import { isHttpFindingRetestsEnabled } from "@/lib/findings/http-retest-policy";
import {
  getHttpRetestState,
  httpRetestEnvironmentRevision,
  runHttpRetest,
  saveHttpRetestRecipe,
} from "@/lib/findings/http-retest-service";

// Acquisition (30 s) + runner (40 s) + Convex writes, inside the 120 s lease.
export const maxDuration = 100;

const MAX_BODY_BYTES = 64 * 1024;
const findingId = z.string().trim().min(1).max(128);

const saveRequest = z
  .object({
    findingId,
    expectedVersion: z.number().int().min(0).max(1_000),
    recipe: z.unknown(),
  })
  .strict();

const runRequest = z
  .object({
    findingId,
    recipeVersion: z.number().int().min(1).max(1_000),
    requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    reviewedOrigin: z.string().max(255),
    reviewedEnvironment: z.string().regex(/^[0-9a-f]{64}$/),
    authorized: z.literal(true),
    credentials: z.record(z.string(), z.string()),
  })
  .strict();

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const environmentKind = (preference: string) =>
  preference === "e2b" ? "cloud" : "local";

async function readBody(req: NextRequest): Promise<unknown> {
  if (
    !req.body ||
    !/^application\/json(?:\s*;|$)/i.test(
      req.headers.get("content-type") ?? "",
    ) ||
    Number(req.headers.get("content-length")) > MAX_BODY_BYTES
  )
    return null;
  const reader = req.body.getReader();
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Never echo request bodies, credentials or exception text. */
function failure(operation: string, error: unknown) {
  if (error instanceof ChatSDKError) return error.toResponse();
  try {
    phLogger.warn("finding_http_retest_request_failed", {
      operation,
      failure_kind: error instanceof Error ? "error" : "thrown_value",
    });
  } catch {
    // Diagnostics cannot replace the response.
  }
  return json({ message: "Retests are unavailable right now." }, 503);
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    if (!(await isHttpFindingRetestsEnabled(userId)))
      return json({ enabled: false });
    const id = findingId.safeParse(req.nextUrl.searchParams.get("findingId"));
    if (!id.success) return json({ message: "Invalid finding" }, 400);
    const state = await getHttpRetestState({ userId, findingId: id.data });
    if (!state.available) return json({ message: "Finding unavailable" }, 404);
    return json({
      enabled: true,
      finding: {
        finding_id: state.finding.finding_id,
        chat_title: state.finding.chat_title,
        target: state.finding.target,
      },
      environment: {
        kind: environmentKind(state.finding.sandbox_preference),
        revision: httpRetestEnvironmentRevision(
          id.data,
          state.finding.sandbox_preference,
        ),
      },
      recipe: state.recipe,
      runs: state.runs,
      server_time: Date.now(),
    });
  } catch (error) {
    return failure("get", error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    if (!(await isHttpFindingRetestsEnabled(userId)))
      return json({ message: "Retests are not available." }, 403);
    const parsed = saveRequest.safeParse(await readBody(req));
    if (!parsed.success)
      return json({ message: "Invalid recipe request" }, 400);
    const result = await saveHttpRetestRecipe({
      userId,
      findingId: parsed.data.findingId,
      expectedVersion: parsed.data.expectedVersion,
      recipe: parsed.data.recipe,
      source: "user",
    });
    if (result.success) return json(result);
    const status =
      result.error === "not_found"
        ? 404
        : result.error === "conflict"
          ? 409
          : 400;
    return json(result, status);
  } catch (error) {
    return failure("save", error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    if (!(await isHttpFindingRetestsEnabled(userId)))
      return json({ message: "Retests are not available." }, 403);
    const parsed = runRequest.safeParse(await readBody(req));
    if (!parsed.success)
      return json(
        {
          message:
            "Review the recipe, confirm you're authorized and enter its credentials.",
        },
        400,
      );
    const result = await runHttpRetest({
      userId,
      subscription,
      findingId: parsed.data.findingId,
      requestId: parsed.data.requestId,
      recipeVersion: parsed.data.recipeVersion,
      reviewedOrigin: parsed.data.reviewedOrigin,
      reviewedEnvironment: parsed.data.reviewedEnvironment,
      credentials: parsed.data.credentials,
    });
    if (result.success) return json(result);
    const status = {
      not_found: 404,
      conflict: 409,
      busy: 409,
      rate_limited: 429,
      validation: 400,
    }[result.error];
    return json(result, status);
  } catch (error) {
    return failure("run", error);
  }
}
