import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 10;

const TRIGGER_STATUS_URL = "https://status.trigger.dev/index.json";
const OPERATIONAL_STATUS = "operational";

const REQUIRED_TRIGGER_RESOURCES = [
  {
    id: "8931867",
    name: "US East task execution",
  },
  {
    id: "8931869",
    name: "EU Central task execution",
  },
  {
    id: "8649602",
    name: "Global realtime",
  },
] as const;

type RequiredTriggerResource = (typeof REQUIRED_TRIGGER_RESOURCES)[number];

type TriggerResourceCheck = {
  id: RequiredTriggerResource["id"];
  name: RequiredTriggerResource["name"];
  status: string;
  operational: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStatusPageResource(
  feed: unknown,
  resourceId: RequiredTriggerResource["id"],
): Record<string, unknown> | null {
  if (!isRecord(feed) || !Array.isArray(feed.included)) return null;

  for (const item of feed.included) {
    if (!isRecord(item)) continue;
    if (item.id !== resourceId || item.type !== "status_page_resource") {
      continue;
    }
    return item;
  }

  return null;
}

function getResourceStatus(
  feed: unknown,
  resource: RequiredTriggerResource,
): TriggerResourceCheck {
  const item = getStatusPageResource(feed, resource.id);
  if (!item) {
    return {
      id: resource.id,
      name: resource.name,
      status: "missing",
      operational: false,
    };
  }

  const attributes = isRecord(item.attributes) ? item.attributes : null;
  const status =
    typeof attributes?.status === "string" ? attributes.status : "unknown";

  return {
    id: resource.id,
    name: resource.name,
    status,
    operational: status === OPERATIONAL_STATUS,
  };
}

function buildHealthResponse(resources: TriggerResourceCheck[]) {
  const ok = resources.every((resource) => resource.operational);

  return {
    ok,
    source: TRIGGER_STATUS_URL,
    checkedAt: new Date().toISOString(),
    resources,
  };
}

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

export async function GET() {
  try {
    const response = await fetch(TRIGGER_STATUS_URL, {
      cache: "no-store",
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return json(
        {
          ok: false,
          source: TRIGGER_STATUS_URL,
          checkedAt: new Date().toISOString(),
          error: "trigger_status_unavailable",
          sourceStatus: response.status,
        },
        { status: 503 },
      );
    }

    const feed = await response.json();
    const resources = REQUIRED_TRIGGER_RESOURCES.map((resource) =>
      getResourceStatus(feed, resource),
    );
    const body = buildHealthResponse(resources);

    return json(body, { status: body.ok ? 200 : 503 });
  } catch (error) {
    const checkedAt = new Date().toISOString();
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "trigger_agent_health_status_fetch_failed",
        service: "zhacker",
        timestamp: checkedAt,
        source: TRIGGER_STATUS_URL,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: error instanceof Error ? error.message : "Unknown error",
        environment: process.env.VERCEL_ENV,
        vercel_region: process.env.VERCEL_REGION,
      }),
    );

    return json(
      {
        ok: false,
        source: TRIGGER_STATUS_URL,
        checkedAt,
        error: "trigger_status_fetch_failed",
        message: "Failed to fetch Trigger status feed.",
      },
      { status: 503 },
    );
  }
}
