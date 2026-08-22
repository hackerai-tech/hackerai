import { createHash, timingSafeEqual } from "node:crypto";
import { runs, tasks } from "@trigger.dev/sdk";
import { NextResponse, type NextRequest } from "next/server";
import type { pmUserResearch } from "@/trigger/user-research";
import {
  pmUserResearchGatewayRequestSchema,
  pmUserResearchResultSchema,
} from "@/lib/research/user-research";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 15;
export const runtime = "nodejs";

const GATEWAY_TAG = "pm-user-research-gateway";
const GATEWAY_REQUESTER = "pm-gateway";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const RUN_ID_PATTERN = /^run_[A-Za-z0-9]+$/;
const MAX_REQUEST_BYTES = 32 * 1024;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

class RequestBodyTooLargeError extends Error {}

function json(body: Record<string, unknown>, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

function requestId(request: NextRequest): string {
  return (
    request.headers.get("x-request-id") ??
    request.headers.get("x-vercel-id") ??
    crypto.randomUUID()
  ).slice(0, 128);
}

function audit(
  request: NextRequest,
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    request_id: requestId(request),
    service: "hackerai-web",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    ...fields,
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
}

function getBearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function isAuthorized(
  request: NextRequest,
): "authorized" | "unauthorized" | "misconfigured" {
  const expectedHash = process.env.PM_USER_RESEARCH_RUNNER_KEY_SHA256?.trim();
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    return "misconfigured";
  }

  const token = getBearerToken(request);
  if (!token) return "unauthorized";

  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return timingSafeEqual(actual, expected) ? "authorized" : "unauthorized";
}

function authenticate(request: NextRequest): NextResponse | null {
  const result = isAuthorized(request);
  if (result === "authorized") return null;

  if (result === "misconfigured") {
    audit(request, "error", "pm_user_research_gateway_misconfigured");
    return json({ error: "research_gateway_unavailable" }, { status: 503 });
  }

  audit(request, "warn", "pm_user_research_gateway_auth_rejected");
  return json({ error: "unauthorized" }, { status: 401 });
}

async function readBoundedJson(request: NextRequest): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function POST(request: NextRequest) {
  const authResponse = authenticate(request);
  if (authResponse) return authResponse;

  const contentLengthHeader = request.headers.get("content-length");
  if (
    contentLengthHeader &&
    /^\d+$/.test(contentLengthHeader) &&
    Number(contentLengthHeader) > MAX_REQUEST_BYTES
  ) {
    return json({ error: "payload_too_large" }, { status: 413 });
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return json({ error: "invalid_idempotency_key" }, { status: 400 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "payload_too_large" }, { status: 413 });
    }
    return json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = pmUserResearchGatewayRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return json(
      {
        error: "invalid_payload",
        issues: parsed.error.issues.map(({ code, message, path }) => ({
          code,
          message,
          path,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const handle = await tasks.trigger<typeof pmUserResearch>(
      "pm-user-research",
      { ...parsed.data, requestedBy: GATEWAY_REQUESTER },
      {
        idempotencyKey: `pm-research:${idempotencyKey}`,
        idempotencyKeyTTL: "24h",
        tags: [GATEWAY_TAG],
      },
    );

    audit(request, "info", "pm_user_research_run_started", {
      run_id: handle.id,
      ...(parsed.data.linearIssueId
        ? { linear_issue_id: parsed.data.linearIssueId }
        : {}),
      cohort_size: parsed.data.userIds.length,
      requested_by: GATEWAY_REQUESTER,
    });

    return json(
      {
        runId: handle.id,
        status: "queued",
        statusPath: `/api/internal/user-research?runId=${encodeURIComponent(handle.id)}`,
      },
      { status: 202 },
    );
  } catch (error) {
    audit(request, "error", "pm_user_research_run_start_failed", {
      ...(parsed.data.linearIssueId
        ? { linear_issue_id: parsed.data.linearIssueId }
        : {}),
      cohort_size: parsed.data.userIds.length,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "research_run_start_failed" }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  const authResponse = authenticate(request);
  if (authResponse) return authResponse;

  const runId = request.nextUrl.searchParams.get("runId")?.trim();
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    return json({ error: "invalid_run_id" }, { status: 400 });
  }

  try {
    const run = await runs.retrieve<typeof pmUserResearch>(runId);
    if (
      run.taskIdentifier !== "pm-user-research" ||
      !run.tags.includes(GATEWAY_TAG)
    ) {
      audit(request, "warn", "pm_user_research_run_access_rejected", {
        run_id: runId,
      });
      return json({ error: "run_not_found" }, { status: 404 });
    }

    if (run.isSuccess) {
      const output = pmUserResearchResultSchema.safeParse(run.output);
      if (!output.success) {
        audit(request, "error", "pm_user_research_run_output_invalid", {
          run_id: runId,
        });
        return json({ error: "research_run_output_invalid" }, { status: 502 });
      }
      return json({ runId, status: "completed", result: output.data });
    }

    if (run.isFailed || run.isCancelled) {
      return json({ runId, status: "failed", error: "research_run_failed" });
    }

    return json({ runId, status: "running" });
  } catch (error) {
    audit(request, "error", "pm_user_research_run_status_failed", {
      run_id: runId,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "research_run_status_failed" }, { status: 502 });
  }
}
