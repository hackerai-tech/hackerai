import {
  normalizeProxyInput,
  type ProxyInput,
} from "@/lib/cloud-network/proxy";
import { NextRequest, NextResponse } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { normalizeNetworkPolicy } from "@/lib/cloud-network/policy";
import {
  readNetworkSettings,
  saveNetworkSettings,
  defaultNetworkSettings,
  NetworkSettingsError,
} from "@/lib/cloud-network/service";
import { phLogger } from "@/lib/posthog/server";

export const maxDuration = 60;
async function user(request: NextRequest) {
  const { userId, subscription } = await getUserIDAndPro(request);
  if (subscription === "free")
    throw new ChatSDKError(
      "forbidden:api",
      "Cloud network settings require a cloud-enabled plan.",
    );
  return userId;
}
function failure(error: unknown) {
  if (error instanceof ChatSDKError) return error.toResponse();
  if (error instanceof NetworkSettingsError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  return NextResponse.json(
    { error: "Cloud network settings are unavailable. Please retry." },
    { status: 503 },
  );
}
export async function GET(request: NextRequest) {
  try {
    const userId = await user(request);
    return NextResponse.json(
      {
        ...((await readNetworkSettings(userId)) ?? defaultNetworkSettings()),
        proxyAvailable: process.env.E2B_BYOP_ENABLED === "true",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PUT(request: NextRequest) {
  try {
    const userId = await user(request);
    let policy, expectedRevision;
    let proxy: ProxyInput | null | undefined;
    try {
      const body = await request.json();
      if (
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0
      )
        throw new Error("Reload network settings before saving.");
      expectedRevision = body.expectedRevision;
      policy = normalizeNetworkPolicy(body.policy);
      proxy =
        body.proxy === undefined
          ? undefined
          : body.proxy === null
            ? null
            : normalizeProxyInput(body.proxy);
    } catch {
      return NextResponse.json(
        {
          error:
            "Use valid hostnames, wildcards, IPv4 addresses or CIDRs. URLs, IPv6 and ports are not supported. Restricted mode needs at least one destination. Proxies require hostname:port and optional credentials of at most 255 bytes.",
        },
        { status: 400 },
      );
    }
    const saved = await saveNetworkSettings(
      userId,
      policy,
      expectedRevision,
      proxy,
    );
    phLogger.event("cloud_network_settings_saved", {
      userId,
      mode: policy.mode,
      destination_count: policy.allow.length,
    });
    return NextResponse.json(saved);
  } catch (error) {
    return failure(error);
  }
}
