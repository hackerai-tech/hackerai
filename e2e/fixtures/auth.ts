import { Page, BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { TIMEOUTS } from "../constants";
import {
  getTestUsersRecord,
  type TestUser as TestUserFromConfig,
} from "../../scripts/test-users-config";

export type TestUser = TestUserFromConfig;

export const TEST_USERS = getTestUsersRecord();

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

/** Storage state file paths by tier (relative to project root). Use for setup and test.use(). */
export const AUTH_STORAGE_PATHS = {
  free: "e2e/.auth/free.json",
  pro: "e2e/.auth/pro.json",
  ultra: "e2e/.auth/ultra.json",
} as const satisfies Record<"free" | "pro" | "ultra", string>;

function getStorageStatePath(user: TestUser): string {
  return join(process.cwd(), AUTH_STORAGE_PATHS[user.tier]);
}

interface PlaywrightStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

async function tryLoadFromStorageStateFile(
  page: Page,
  storagePath: string,
): Promise<boolean> {
  try {
    const state: PlaywrightStorageState = JSON.parse(
      readFileSync(storagePath, "utf-8"),
    );
    await page.context().addCookies(state.cookies);
    await page.goto("/");
    return true;
  } catch {
    return false;
  }
}

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

  if (!skipCache) {
    // 1. Try storage state file (e.g. e2e/.auth/pro.json) - survives process restarts
    const storagePath = getStorageStatePath(user);
    if (existsSync(storagePath)) {
      const ok = await tryLoadFromStorageStateFile(page, storagePath);
      if (ok) {
        const userMenuButton = page
          .getByTestId("user-menu-button")
          .or(page.getByTestId("user-menu-button-collapsed"));
        const isAuthenticated = await userMenuButton
          .isVisible({ timeout: TIMEOUTS.SHORT })
          .catch(() => false);
        if (isAuthenticated) {
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
          await page.context().storageState({ path: storagePath });
          return;
        }
      }
    }

    // 2. Try in-memory session cache (same process only)
    const cached = sessionCache.get(cacheKey);
    if (cached && isSessionValid(cached)) {
      await page.context().addCookies(cached.cookies);
      await page.goto("/");

      const userMenuButton = page
        .getByTestId("user-menu-button")
        .or(page.getByTestId("user-menu-button-collapsed"));
      const isAuthenticated = await userMenuButton
        .isVisible({ timeout: TIMEOUTS.SHORT })
        .catch(() => false);
      if (isAuthenticated) {
        await page.context().storageState({ path: getStorageStatePath(user) });
        return;
      }
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

      await page.context().storageState({ path: getStorageStatePath(user) });
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
