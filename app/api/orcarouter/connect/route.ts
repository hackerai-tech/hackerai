import { NextRequest } from "next/server";
import { json } from "@/lib/api/response";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import { resolveOrcaRouterEndpoints } from "@/lib/ai/orcarouter/config";
import { isOrcaRouterCredentialStorageConfigured } from "@/lib/ai/orcarouter/credential-crypto";
import {
  ORCAROUTER_CALLBACK_PATH,
  ORCAROUTER_PKCE_COOKIE,
  ORCAROUTER_PKCE_TTL_SECONDS,
  sealPendingPkceAttempt,
} from "@/lib/ai/orcarouter/credentials";
import {
  buildOrcaRouterAuthorizeUrl,
  createPkceAttempt,
} from "@/lib/ai/orcarouter/pkce";

/**
 * Starts "Connect with OrcaRouter" (OAuth 2.0 + PKCE, S256). The browser is
 * sent to OrcaRouter's consent screen and returns to this app's own callback;
 * the verifier stays server-side in a sealed, httpOnly cookie.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    if (!isOrcaRouterCredentialStorageConfigured()) {
      return json(
        { error: "OrcaRouter is not enabled on this deployment." },
        { status: 503 },
      );
    }

    const attempt = createPkceAttempt();
    const authorizeUrl = buildOrcaRouterAuthorizeUrl({
      authOrigin: resolveOrcaRouterEndpoints().authOrigin,
      callbackUrl: new URL(
        ORCAROUTER_CALLBACK_PATH,
        req.nextUrl.origin,
      ).toString(),
      challenge: attempt.challenge,
      state: attempt.state,
    });

    const response = json({ authorizeUrl });
    response.cookies.set(
      ORCAROUTER_PKCE_COOKIE,
      sealPendingPkceAttempt(userId, attempt),
      {
        httpOnly: true,
        secure: req.nextUrl.protocol === "https:",
        // Lax is sent on the top-level GET redirect back from OrcaRouter.
        sameSite: "lax",
        path: ORCAROUTER_CALLBACK_PATH,
        maxAge: ORCAROUTER_PKCE_TTL_SECONDS,
      },
    );
    return response;
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("OrcaRouter connect failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "Something went wrong." }, { status: 500 });
  }
}
