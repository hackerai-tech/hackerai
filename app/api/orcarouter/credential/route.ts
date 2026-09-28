import { NextRequest } from "next/server";
import { json } from "@/lib/api/response";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { isOrcaRouterCredentialStorageConfigured } from "@/lib/ai/orcarouter/credential-crypto";
import {
  clearOrcaRouterCredential,
  credentialFromApiKey,
  getOrcaRouterCredentialStatus,
  OrcaRouterCredentialInputError,
  saveOrcaRouterCredential,
} from "@/lib/ai/orcarouter/credentials";

const notConfigured = () =>
  json(
    { error: "OrcaRouter is not enabled on this deployment." },
    { status: 503 },
  );

const failure = (error: unknown, action: string) => {
  if (error instanceof ChatSDKError) return error.toResponse();
  console.error(`OrcaRouter credential ${action} failed`, {
    error: error instanceof Error ? error.name : "unknown",
  });
  return json({ error: "Something went wrong." }, { status: 500 });
};

/** Connection status only; the key itself never leaves the server. */
export async function GET(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    if (!isOrcaRouterCredentialStorageConfigured()) {
      return json({ enabled: false, connected: false });
    }
    return json({
      enabled: true,
      ...(await getOrcaRouterCredentialStatus(userId)),
    });
  } catch (error) {
    return failure(error, "status");
  }
}

/** API-key adapter: saves a pasted `sk-orca-…` key. */
export async function PUT(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    if (!isOrcaRouterCredentialStorageConfigured()) return notConfigured();
    const body = (await req.json().catch(() => null)) as {
      apiKey?: unknown;
    } | null;
    const credential = credentialFromApiKey(body?.apiKey);
    await saveOrcaRouterCredential(userId, credential);
    return json({
      enabled: true,
      ...(await getOrcaRouterCredentialStatus(userId)),
    });
  } catch (error) {
    if (error instanceof OrcaRouterCredentialInputError) {
      return json({ error: error.message }, { status: 400 });
    }
    return failure(error, "save");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    await clearOrcaRouterCredential(userId);
    return json({
      enabled: isOrcaRouterCredentialStorageConfigured(),
      connected: false,
    });
  } catch (error) {
    return failure(error, "clear");
  }
}
