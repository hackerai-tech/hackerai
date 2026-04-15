import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { isUnauthorizedError } from "@/lib/api/response";
import {
  clearByokApiKey,
  getByokApiKeyHint,
  hasByokApiKey,
  setByokApiKey,
} from "@/lib/auth/byok";
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

type ValidationResult =
  | { ok: true }
  | { ok: false; status: 400 | 502 | 504; error: string };

async function validateOpenRouterKey(
  apiKey: string,
): Promise<ValidationResult> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      // Genuine client error — the key is bad.
      return { ok: false, status: 400, error: "Invalid OpenRouter API key" };
    }
    if (!res.ok) {
      // OpenRouter is up but returned an error we don't understand. Bubble
      // up as 502 so clients/CDNs can apply 5xx retry semantics.
      return {
        ok: false,
        status: 502,
        error: `OpenRouter returned ${res.status}. Try again.`,
      };
    }
    return { ok: true };
  } catch {
    // Network error or timeout reaching OpenRouter — gateway timeout.
    return {
      ok: false,
      status: 504,
      error: "Could not reach OpenRouter. Try again.",
    };
  }
}

export async function GET(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    if (subscription === "free") {
      return NextResponse.json({
        hasKey: false,
        enabled: false,
        keyHint: null,
      });
    }
    // `hasKey` is derived from Vault presence (source of truth); `enabled`
    // is the user's toggle preference. They're stored separately so a user
    // can disable BYOK without deleting their key, but they must stay
    // consistent: enabled cannot be true without a key.
    // `keyHint` is a redacted preview (e.g. "sk-or-v1-78d...308") so the
    // user can confirm which key is saved without exposing the full value.
    const [customization, keyHint] = await Promise.all([
      getUserCustomization({ userId }),
      getByokApiKeyHint(userId),
    ]);
    const hasKey = !!keyHint;
    let enabled = !!customization?.byok_enabled;
    // Self-heal: if the flag is true but no key exists in Vault (e.g. someone
    // deleted it externally), clear the flag so the UI never shows "enabled"
    // without a key behind it.
    if (enabled && !hasKey) {
      await setByokEnabled(userId, false);
      enabled = false;
    }
    return NextResponse.json({
      hasKey,
      enabled,
      keyHint: keyHint ?? null,
    });
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
        { status: validation.status },
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

export async function PATCH(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    if (subscription === "free") {
      return NextResponse.json(
        { error: "A paid plan is required to use a custom API key" },
        { status: 403 },
      );
    }

    let body: { enabled?: boolean };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled (boolean) is required" },
        { status: 400 },
      );
    }

    // When enabling, require a key already exists in the vault.
    if (body.enabled && !(await hasByokApiKey(userId))) {
      return NextResponse.json(
        { error: "Add an API key before enabling BYOK" },
        { status: 400 },
      );
    }

    await setByokEnabled(userId, body.enabled);
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = isUnauthorizedError(error) ? 401 : 500;
    return NextResponse.json(
      {
        error: status === 401 ? "Unauthorized" : "Failed to update BYOK state",
      },
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
