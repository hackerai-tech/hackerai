import type { Page } from "@playwright/test";

const LOCAL_APP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const AUTH_SHELL_TIMEOUT_MS = 2000;

interface AuthCallbackMismatch {
  appOrigin: string;
  redirectUri: string;
  redirectOrigin: string;
}

export class E2EAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2EAuthConfigurationError";
  }
}

export function getLocalAuthCallbackMismatch(
  appUrl: string,
  authorizationUrl: string,
): AuthCallbackMismatch | null {
  try {
    const app = new URL(appUrl);
    if (!LOCAL_APP_HOSTS.has(app.hostname)) return null;

    const redirectUri = new URL(authorizationUrl, app).searchParams.get(
      "redirect_uri",
    );
    if (!redirectUri) return null;

    const redirect = new URL(redirectUri);
    if (redirect.origin === app.origin) return null;

    return {
      appOrigin: app.origin,
      redirectUri: redirect.toString(),
      redirectOrigin: redirect.origin,
    };
  } catch {
    return null;
  }
}

export async function assertLocalAuthCallbackMatchesApp(
  page: Page,
): Promise<void> {
  const response = await page.request.get("/login", { maxRedirects: 0 });
  const headers = response.headers();
  const authorizationUrl =
    headers["x-workos-authorization-url"] ?? headers.location;
  if (!authorizationUrl) return;

  const mismatch = getLocalAuthCallbackMismatch(
    response.url(),
    authorizationUrl,
  );
  if (!mismatch) return;

  throw new E2EAuthConfigurationError(
    `E2E auth callback mismatch: tests use ${mismatch.appOrigin}, but WorkOS redirects to ${mismatch.redirectUri}. Run the app on ${mismatch.redirectOrigin}, or update NEXT_PUBLIC_WORKOS_REDIRECT_URI and the WorkOS redirect allowlist to match the test origin.`,
  );
}

export async function assertAuthenticatedSession(page: Page): Promise<void> {
  const userMenuButton = page
    .getByTestId("user-menu-button")
    .or(page.getByTestId("user-menu-button-collapsed"));
  const isAuthenticated = await userMenuButton
    .isVisible({ timeout: AUTH_SHELL_TIMEOUT_MS })
    .catch(() => false);
  if (isAuthenticated) return;

  throw new E2EAuthConfigurationError(
    "E2E auth state is missing or stale. Run `corepack pnpm test:e2e --project=setup --workers=1` before isolated `--no-deps` chat, file, or Agent tests.",
  );
}
