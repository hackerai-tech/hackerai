import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 10;
export const runtime = "nodejs";

const WORKOS_USERS_URL = "https://api.workos.com/user_management/users?limit=1";
const WORKOS_FETCH_TIMEOUT_MS = 4_000;
const HEALTH_CHECK_TOKEN_HEADER = "x-hackerai-health-token";

type DependencyHealth = {
  ok: boolean;
  status: number | null;
  latencyMs: number;
};

function json(
  body: Record<string, unknown>,
  init?: ResponseInit,
): NextResponse<Record<string, unknown>> {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");

  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

function getWorkOSFetchSignal(): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  const timeout = (
    AbortSignal as typeof AbortSignal & {
      timeout?: (milliseconds: number) => AbortSignal;
    }
  ).timeout;

  return timeout?.(WORKOS_FETCH_TIMEOUT_MS);
}

function tokensMatch(providedToken: string | null, expectedToken: string) {
  if (!providedToken) return false;

  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function logHealthFailure(
  request: NextRequest,
  checkedAt: string,
  fields: Record<string, unknown>,
) {
  console.warn(
    JSON.stringify({
      timestamp: checkedAt,
      level: "warn",
      event: "core_health_check_failed",
      request_id:
        request.headers.get("x-request-id") ??
        request.headers.get("x-vercel-id") ??
        "unknown",
      service: "hackerai-web",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      dependency: "workos",
      ...fields,
    }),
  );
}

function unhealthyResponse(
  checkedAt: string,
  workos: DependencyHealth,
  error: string,
) {
  return json(
    {
      ok: false,
      service: "core",
      checkedAt,
      error,
      dependencies: {
        workos,
      },
    },
    { status: 503 },
  );
}

export async function GET(request: NextRequest) {
  const healthCheckToken = process.env.CORE_HEALTH_CHECK_TOKEN;
  const workosApiKey = process.env.WORKOS_API_KEY;

  if (!healthCheckToken || !workosApiKey) {
    const checkedAt = new Date().toISOString();
    logHealthFailure(request, checkedAt, {
      reason: "missing_configuration",
      missing_health_check_token: !healthCheckToken,
      missing_workos_api_key: !workosApiKey,
    });

    return unhealthyResponse(
      checkedAt,
      {
        ok: false,
        status: null,
        latencyMs: 0,
      },
      "health_check_not_configured",
    );
  }

  if (
    !tokensMatch(
      request.headers.get(HEALTH_CHECK_TOKEN_HEADER),
      healthCheckToken,
    )
  ) {
    return json(
      {
        ok: false,
        service: "core",
        checkedAt: new Date().toISOString(),
        error: "unauthorized",
      },
      { status: 401 },
    );
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(WORKOS_USERS_URL, {
      cache: "no-store",
      signal: getWorkOSFetchSignal(),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${workosApiKey}`,
      },
    });
    const checkedAt = new Date().toISOString();
    const latencyMs = Date.now() - startedAt;
    const workos = {
      ok: response.ok,
      status: response.status,
      latencyMs,
    };

    if (!response.ok) {
      logHealthFailure(request, checkedAt, {
        reason: "unexpected_status",
        dependency_status: response.status,
        duration_ms: latencyMs,
      });

      return unhealthyResponse(checkedAt, workos, "workos_unavailable");
    }

    return json(
      {
        ok: true,
        service: "core",
        checkedAt,
        dependencies: {
          workos,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const checkedAt = new Date().toISOString();
    const latencyMs = Date.now() - startedAt;
    logHealthFailure(request, checkedAt, {
      reason: "fetch_failed",
      duration_ms: latencyMs,
      timeout_ms: WORKOS_FETCH_TIMEOUT_MS,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: error instanceof Error ? error.message : "Unknown error",
    });

    return unhealthyResponse(
      checkedAt,
      {
        ok: false,
        status: null,
        latencyMs,
      },
      "workos_fetch_failed",
    );
  }
}
