import { Page, BrowserContext } from "@playwright/test";
import { TIMEOUTS } from "../constants";
import { SubscriptionTier } from "@/types/chat";

export interface TestUser {
  email: string;
  password: string;
  tier: SubscriptionTier;
}

export const TEST_USERS: Record<"free" | "pro" | "ultra", TestUser> = {
  free: {
    email: process.env.TEST_FREE_TIER_USER || "free@hackerai.com",
    password: process.env.TEST_FREE_TIER_PASSWORD || "l#m3Y4d)P^umI-E-",
    tier: "free",
  },
  pro: {
    email: process.env.TEST_PRO_TIER_USER || "pro@hackerai.com",
    password: process.env.TEST_PRO_TIER_PASSWORD || "i.LY[^H6D=ZVeFgo",
    tier: "pro",
  },
  ultra: {
    email: process.env.TEST_ULTRA_TIER_USER || "ultra@hackerai.com",
    password: process.env.TEST_ULTRA_TIER_PASSWORD || "U<hD`:b23JUa66g]",
    tier: "ultra",
  },
};

interface SessionCache {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  timestamp: number;
}

const sessionCache = new Map<string, SessionCache>();
const SESSION_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

function isSessionValid(cache: SessionCache): boolean {
  const now = Date.now();
  const isExpired = now - cache.timestamp > SESSION_CACHE_DURATION;
  if (isExpired) return false;

  // Check if cookies themselves are expired
  return cache.cookies.some((cookie) => {
    return cookie.expires === -1 || cookie.expires > now / 1000;
  });
}

export interface AuthOptions {
  skipCache?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

export async function authenticateUser(
  page: Page,
  user: TestUser,
  options: AuthOptions = {},
): Promise<void> {
  const { skipCache = false, maxRetries = 3, retryDelay = 1000 } = options;

  const cacheKey = user.email;

  // Try to use cached session if available
  if (!skipCache) {
    const cached = sessionCache.get(cacheKey);
    if (cached && isSessionValid(cached)) {
      await page.context().addCookies(cached.cookies);
      await page.goto("/");

      // Verify session is still valid by checking for authenticated UI
      // Check for both collapsed and expanded user menu button
      const userMenuButton = page
        .getByTestId("user-menu-button")
        .or(page.getByTestId("user-menu-button-collapsed"));
      const isAuthenticated = await userMenuButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);
      if (isAuthenticated) {
        return;
      }
      // If verification failed, clear cache and proceed with login
      sessionCache.delete(cacheKey);
    }
  }

  // Perform login with retry logic
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await performLogin(page, user);

      // Cache the session
      const cookies = await page.context().cookies();
      const sessionCookies = cookies.filter(
        (c) => c.name.startsWith("wos-") || c.name === "session",
      );

      if (sessionCookies.length > 0) {
        sessionCache.set(cacheKey, {
          cookies: sessionCookies,
          timestamp: Date.now(),
        });
      }

      return;
    } catch (error) {
      lastError = error as Error;
      console.warn(
        `Login attempt ${attempt + 1} failed for ${user.email}:`,
        error,
      );

      if (attempt < maxRetries - 1) {
        // Exponential backoff
        const delay = retryDelay * Math.pow(2, attempt);
        console.log(`Retrying in ${delay}ms...`);
        await page.waitForTimeout(delay);
      }
    }
  }

  throw new Error(
    `Failed to authenticate after ${maxRetries} attempts: ${lastError?.message}`,
  );
}

async function performLogin(page: Page, user: TestUser): Promise<void> {
  // Navigate to login page
  await page.goto("/login");

  // Wait for WorkOS login page to load
  await page.waitForLoadState("networkidle");

  // Step 1: Enter email and click Continue
  // WorkOS uses a two-step process: email first, then password
  const emailInput = page.getByRole("textbox", { name: "Email" });
  await emailInput.waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
  await emailInput.fill(user.email);

  const continueButton = page.getByRole("button", { name: "Continue" });
  await continueButton.click({ force: true });

  // Step 2: Enter password and submit
  // Wait for password input to appear
  const passwordInput = page.getByRole("textbox", { name: "Password" });
  await passwordInput.waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
  await passwordInput.fill(user.password);

  // Submit the form
  const submitButton = page.getByRole("button", {
    name: /continue|sign in|log in/i,
  });
  await submitButton.click({ force: true });

  // Wait for redirect to app (callback then dashboard/home)
  await page.waitForURL(
    (url) => {
      return url.pathname === "/" || url.pathname.startsWith("/c/");
    },
    { timeout: TIMEOUTS.MEDIUM },
  );

  // Wait for authenticated UI to appear - check for either collapsed or expanded user menu
  const userMenuButton = page
    .getByTestId("user-menu-button")
    .or(page.getByTestId("user-menu-button-collapsed"));
  await userMenuButton.waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
}

export async function logout(page: Page): Promise<void> {
  // Open user menu - check for either collapsed or expanded version
  const userMenuButton = page
    .getByTestId("user-menu-button")
    .or(page.getByTestId("user-menu-button-collapsed"));
  await userMenuButton.click({ force: true });

  // Click logout button
  const logoutButton = page.getByTestId("logout-button");
  await logoutButton.click({ force: true });

  // Wait for redirect to home page
  await page.waitForURL("/", { timeout: TIMEOUTS.SHORT });

  // Verify logged out state - sign in button should be visible
  await page
    .getByTestId("sign-in-button")
    .waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
}

export async function clearAuthCache(): Promise<void> {
  sessionCache.clear();
}

export async function getAuthState(context: BrowserContext): Promise<{
  isAuthenticated: boolean;
  hasCookies: boolean;
}> {
  const cookies = await context.cookies();
  const sessionCookies = cookies.filter((c) => c.name.startsWith("wos-"));

  return {
    isAuthenticated: sessionCookies.length > 0,
    hasCookies: sessionCookies.length > 0,
  };
}
