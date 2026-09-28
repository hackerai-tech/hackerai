import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { resolveOrcaRouterEndpoints } from "@/lib/ai/orcarouter/config";
import {
  credentialFromPkceCallback,
  openPendingPkceAttempt,
  ORCAROUTER_CALLBACK_PATH,
  ORCAROUTER_PKCE_COOKIE,
  saveOrcaRouterCredential,
} from "@/lib/ai/orcarouter/credentials";
import {
  OrcaRouterAuthError,
  type OrcaRouterAuthErrorKind,
} from "@/lib/ai/orcarouter/auth-errors";
import { ORCAROUTER_CONNECT_RESULT_PARAM } from "@/lib/ai/orcarouter/models";

/**
 * OrcaRouter redirects here with `code` and `state` (or `error`). Every
 * outcome clears the pending attempt and returns the user to the app, where
 * the Model providers settings tab reports the result.
 */
export async function GET(req: NextRequest) {
  const finish = (result: "connected" | OrcaRouterAuthErrorKind) => {
    const target = new URL("/", req.nextUrl.origin);
    target.searchParams.set(ORCAROUTER_CONNECT_RESULT_PARAM, result);
    const response = NextResponse.redirect(target);
    response.cookies.set(ORCAROUTER_PKCE_COOKIE, "", {
      path: ORCAROUTER_CALLBACK_PATH,
      maxAge: 0,
    });
    return response;
  };

  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return finish("state_mismatch");
  }

  const attempt = openPendingPkceAttempt(
    userId,
    req.cookies.get(ORCAROUTER_PKCE_COOKIE)?.value,
  );
  if (!attempt) return finish("state_mismatch");

  try {
    const credential = await credentialFromPkceCallback({
      authOrigin: resolveOrcaRouterEndpoints().authOrigin,
      expectedState: attempt.state,
      verifier: attempt.verifier,
      params: req.nextUrl.searchParams,
    });
    await saveOrcaRouterCredential(userId, credential);
    return finish("connected");
  } catch (error) {
    if (error instanceof OrcaRouterAuthError) return finish(error.kind);
    console.error("OrcaRouter callback failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return finish("network");
  }
}
