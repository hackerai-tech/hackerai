import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { isUnauthorizedError } from "@/lib/api/response";
import { clearByokApiKey, setByokApiKey } from "@/lib/auth/byok";
import { getUserCustomization } from "@/lib/db/actions";

async function setByokEnabled(userId: string, enabled: boolean): Promise<void> {
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  await convex.mutation(api.userCustomization.setByokEnabledForBackend, {
    serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
    userId,
    enabled,
  });
}

interface SaveByokRequest {
  apiKey?: string;
}

async function validateOpenRouterKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Invalid OpenRouter API key" };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `OpenRouter returned ${res.status}. Try again.`,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Could not reach OpenRouter. Try again.",
    };
  }
}

export async function GET(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    if (subscription === "free") {
      return NextResponse.json({ hasKey: false });
    }
    // Source of truth is the Convex flag — avoids a WorkOS Vault round-trip
    // just to answer "does this user have a BYOK key?"
    const customization = await getUserCustomization({ userId });
    return NextResponse.json({ hasKey: !!customization?.byok_enabled });
  } catch (error) {
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to read API key" },
      { status },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    if (subscription === "free") {
      return NextResponse.json(
        { error: "A paid plan is required to use a custom API key" },
        { status: 403 },
      );
    }

    let body: SaveByokRequest;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: "apiKey is required" },
        { status: 400 },
      );
    }
    // Real OpenRouter keys are ~80 chars; reject anything wildly oversized
    // before we forward it upstream.
    if (apiKey.length > 512) {
      return NextResponse.json(
        { error: "apiKey is too long" },
        { status: 400 },
      );
    }
    // OpenRouter keys always start with "sk-or-". Reject obvious mismatches
    // locally instead of round-tripping to OpenRouter.
    if (!apiKey.startsWith("sk-or-")) {
      return NextResponse.json(
        {
          success: false,
          error: "Not an OpenRouter API key — must start with sk-or-",
        },
        { status: 400 },
      );
    }

    const validation = await validateOpenRouterKey(apiKey);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }

    await setByokApiKey(userId, apiKey);
    // Flip the Convex flag last: if vault write succeeded but this fails, the
    // user can retry without losing data. If vault succeeded and flag succeeded,
    // the chat handler will find the key on the next request.
    await setByokEnabled(userId, true);
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to save API key" },
      { status },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    // Flip the flag first so new requests skip the BYOK path immediately,
    // even if the Vault delete lags.
    await setByokEnabled(userId, false);
    await clearByokApiKey(userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Failed to remove API key" },
      { status },
    );
  }
}
