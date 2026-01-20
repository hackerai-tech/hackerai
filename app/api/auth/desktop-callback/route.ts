import { NextRequest } from "next/server";
import { sealData } from "iron-session";
import {
  createDesktopTransferToken,
  verifyAndConsumeOAuthState,
} from "@/lib/desktop-auth";
import { workos } from "@/app/api/workos";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  const noStoreHeaders = {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  };

  if (error || !code) {
    return new Response(
      renderErrorPage("Authentication failed. Please try again."),
      {
        status: 400,
        headers: noStoreHeaders,
      },
    );
  }

  if (!state) {
    console.warn("[Desktop Auth] Missing OAuth state parameter");
    return new Response(
      renderErrorPage("Invalid authentication request. Please try again."),
      {
        status: 400,
        headers: noStoreHeaders,
      },
    );
  }

  const isValidState = await verifyAndConsumeOAuthState(state);
  if (!isValidState) {
    console.warn("[Desktop Auth] Invalid or expired OAuth state");
    return new Response(
      renderErrorPage("Authentication session expired. Please try again."),
      {
        status: 400,
        headers: noStoreHeaders,
      },
    );
  }

  const clientId = process.env.WORKOS_CLIENT_ID;
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD;

  if (!clientId || !cookiePassword) {
    console.error("[Desktop Auth] Missing required environment variables");
    return new Response(
      renderErrorPage("Server configuration error. Please try again later."),
      {
        status: 500,
        headers: noStoreHeaders,
      },
    );
  }

  try {
    const { user, accessToken, refreshToken, impersonator } =
      await workos.userManagement.authenticateWithCode({
        code,
        clientId,
      });

    const session = {
      accessToken,
      refreshToken,
      user,
      impersonator,
    };

    const sealedSession = await sealData(session, {
      password: cookiePassword,
    });

    const transferToken = await createDesktopTransferToken(sealedSession);

    if (!transferToken) {
      return new Response(
        renderErrorPage("Failed to create session transfer. Please try again."),
        {
          status: 500,
          headers: noStoreHeaders,
        },
      );
    }

    const origin = url.origin;
    const deepLinkUrl = `hackerai://auth?token=${encodeURIComponent(transferToken)}&origin=${encodeURIComponent(origin)}`;
    return new Response(renderSuccessPage(deepLinkUrl), {
      status: 200,
      headers: noStoreHeaders,
    });
  } catch (err) {
    console.error("[Desktop Auth] Failed to authenticate:", err);
    return new Response(
      renderErrorPage("Authentication failed. Please try again."),
      {
        status: 500,
        headers: noStoreHeaders,
      },
    );
  }
}

function renderSuccessPage(deepLinkUrl: string): string {
  const safeUrlForHtml = escapeHtml(deepLinkUrl);
  const safeUrlForJs = JSON.stringify(deepLinkUrl);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Redirecting to HackerAI...</title>
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
    .container { text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #888; margin-bottom: 2rem; }
    a {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      background: #22c55e;
      color: #fff;
      text-decoration: none;
      border-radius: 0.5rem;
      font-weight: 500;
    }
    a:hover { background: #16a34a; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Opening HackerAI Desktop...</h1>
    <p>If the app doesn't open automatically, click the button below.</p>
    <a href="${safeUrlForHtml}">Open HackerAI</a>
  </div>
  <script>
    window.location.href = ${safeUrlForJs};
  </script>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  const safeMessage = escapeHtml(message);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Error</title>
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
    .container { text-align: center; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #ef4444; }
    p { color: #888; margin-bottom: 2rem; }
    a {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      background: #333;
      color: #fff;
      text-decoration: none;
      border-radius: 0.5rem;
      font-weight: 500;
    }
    a:hover { background: #444; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Error</h1>
    <p>${safeMessage}</p>
    <a href="hackerai://auth?error=auth_failed">Return to App</a>
  </div>
</body>
</html>`;
}
