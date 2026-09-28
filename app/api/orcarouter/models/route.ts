import { NextRequest } from "next/server";
import { json } from "@/lib/api/response";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { fetchOrcaRouterCatalog } from "@/lib/ai/orcarouter/catalog";
import { resolveOrcaRouterEndpoints } from "@/lib/ai/orcarouter/config";
import {
  getActiveOrcaRouterCredential,
  markOrcaRouterCredentialNeedsReauth,
} from "@/lib/ai/orcarouter/credentials";

/**
 * Lists the chat models the user's OrcaRouter key can call. The key stays on
 * the server; the browser receives only model IDs and input modalities.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    const credential = await getActiveOrcaRouterCredential(userId);
    if (!credential) return json({ status: "not_connected", models: [] });

    const catalog = await fetchOrcaRouterCatalog({
      apiBaseUrl: resolveOrcaRouterEndpoints().apiBaseUrl,
      apiKey: credential.key,
      capability: "chat",
    });
    if (catalog.status === "unauthorized") {
      await markOrcaRouterCredentialNeedsReauth(userId, credential.generation);
    }
    return json(catalog);
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("OrcaRouter model discovery failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "Something went wrong." }, { status: 500 });
  }
}
