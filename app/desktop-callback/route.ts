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

function renderErrorPage(title: string, message: string, retryUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
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
    }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #ef4444; }
    p { color: #888; margin-bottom: 2rem; line-height: 1.6; }
    .buttons { display: flex; gap: 1rem; justify-content: center; }
    button {
      padding: 0.75rem 1.5rem;
      background: #22c55e;
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      font-weight: 500;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: #16a34a; }
    .secondary {
      background: #333;
    }
    .secondary:hover { background: #444; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="buttons">
      <button class="secondary" onclick="window.location.href='/'">Home</button>
      <button onclick="handleRetry()">Try Again</button>
    </div>
  </div>
  <script>
    function handleRetry() {
      if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
        window.__TAURI__.shell.open("${retryUrl}");
      } else {
        window.location.href = "${retryUrl}";
      }
    }
  </script>
</body>
</html>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const error = url.searchParams.get("error");
  const retryUrl = `${url.origin}/desktop-login`;

  if (error === "unauthenticated") {
    return new Response(
      renderErrorPage(
        "Sign In Required",
        "You need to sign in to access this page.",
        retryUrl
      ),
      { status: 401, headers: { "Content-Type": "text/html" } }
    );
  }

  if (!token) {
    console.warn("[Desktop Callback] No token provided in callback URL");
    return new Response(
      renderErrorPage(
        "Authentication Error",
        "No authentication token was provided. Please try signing in again.",
        retryUrl
      ),
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  const sessionData = await exchangeDesktopTransferToken(token);

  if (!sessionData) {
    console.warn("[Desktop Callback] Token exchange failed");
    return new Response(
      renderErrorPage(
        "Session Expired",
        "Your authentication session has expired. This can happen if the sign-in took longer than 60 seconds. Please try again.",
        retryUrl
      ),
      { status: 400, headers: { "Content-Type": "text/html" } }
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
