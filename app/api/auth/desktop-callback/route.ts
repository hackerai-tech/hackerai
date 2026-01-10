import { NextRequest } from "next/server";
import { WorkOS } from "@workos-inc/node";
import { sealData } from "iron-session";
import { createDesktopTransferToken } from "@/lib/desktop-auth";

const workos = new WorkOS(process.env.WORKOS_API_KEY);

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    return new Response(renderErrorPage("Authentication failed. Please try again."), {
      status: 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  try {
    const { user, accessToken, refreshToken, impersonator } =
      await workos.userManagement.authenticateWithCode({
        code,
        clientId: process.env.WORKOS_CLIENT_ID!,
      });

    const session = {
      accessToken,
      refreshToken,
      user,
      impersonator,
    };

    const sealedSession = await sealData(session, {
      password: process.env.WORKOS_COOKIE_PASSWORD!,
    });

    const transferToken = await createDesktopTransferToken(sealedSession);

    if (!transferToken) {
      return new Response(renderErrorPage("Failed to create session transfer. Please try again."), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    const origin = url.origin;
    const deepLinkUrl = `hackerai://auth?token=${transferToken}&origin=${encodeURIComponent(origin)}`;
    return new Response(renderSuccessPage(deepLinkUrl), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  } catch (err) {
    console.error("[Desktop Auth] Failed to authenticate:", err);
    return new Response(renderErrorPage("Authentication failed. Please try again."), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

function renderSuccessPage(deepLinkUrl: string): string {
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
    <a href="${deepLinkUrl}">Open HackerAI</a>
  </div>
  <script>
    window.location.href = "${deepLinkUrl}";
  </script>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
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
    <p>${message}</p>
    <a href="hackerai://auth?error=auth_failed">Return to App</a>
  </div>
</body>
</html>`;
}
