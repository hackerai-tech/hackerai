import { NextResponse } from "next/server";
import { exchangeDesktopTransferToken } from "@/lib/desktop-auth";

function getCookieMaxAge(): number {
  const envMaxAge = process.env.WORKOS_COOKIE_MAX_AGE;
  if (envMaxAge) {
    const parsed = parseInt(envMaxAge, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 60 * 60 * 24 * 400; // 400 days default (WorkOS default)
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderErrorPage(
  title: string,
  message: string,
  retryUrl: string,
): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeRetryUrl = JSON.stringify(retryUrl);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0a0a0a;
      color: #fff;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    .container { text-align: center; max-width: 360px; padding: 1.5rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #ef4444; }
    p { color: #888; margin-bottom: 2rem; line-height: 1.6; }
    .buttons { display: flex; gap: 0.75rem; justify-content: center; }
    button {
      padding: 0.75rem 1.5rem;
      background: #22c55e;
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      font-weight: 500;
      font-size: 1rem;
    }
    .secondary { background: #333; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <div class="buttons">
      <button class="secondary" onclick="window.location.href='/'">Home</button>
      <button onclick="window.location.href=${safeRetryUrl}">Try Again</button>
    </div>
  </div>
</body>
</html>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const error = url.searchParams.get("error");
  const retryUrl = `${url.origin}/login`;

  const noStoreHeaders = {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  };

  if (error === "unauthenticated") {
    return new Response(
      renderErrorPage(
        "Sign In Required",
        "You need to sign in to access this page.",
        retryUrl,
      ),
      { status: 401, headers: noStoreHeaders },
    );
  }

  if (!token) {
    console.warn("[Mobile Callback] No token provided in callback URL");
    return new Response(
      renderErrorPage(
        "Authentication Error",
        "No authentication token was provided. Please try signing in again.",
        retryUrl,
      ),
      { status: 400, headers: noStoreHeaders },
    );
  }

  const sessionData = await exchangeDesktopTransferToken(token);

  if (!sessionData) {
    console.warn("[Mobile Callback] Token exchange failed");
    return new Response(
      renderErrorPage(
        "Session Expired",
        "Your authentication session has expired. Please try signing in again.",
        retryUrl,
      ),
      { status: 400, headers: noStoreHeaders },
    );
  }

  const response = NextResponse.redirect(new URL("/", request.url));

  response.cookies.set("wos-session", sessionData.sealedSession, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getCookieMaxAge(),
  });

  return response;
}
