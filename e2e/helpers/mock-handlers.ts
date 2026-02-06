/**
 * Mock handlers for e2e tests
 *
 * Note: For Playwright e2e tests, we primarily use real services with test data.
 * However, we can intercept and mock certain API calls if needed.
 */

import { Page, Route } from "@playwright/test";

export interface MockConfig {
  enabled: boolean;
  mockWorkOS?: boolean;
  mockConvex?: boolean;
  mockAI?: boolean;
}

export async function setupMocks(
  page: Page,
  config: MockConfig,
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  // Mock AI API calls to prevent rate limiting and costs
  if (config.mockAI) {
    await page.route("**/api/chat", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          message: "This is a mocked AI response for testing",
          done: true,
        }),
      });
    });

    // Agent mode: Vercel streaming (same shape as /api/chat)
    await page.route("**/api/agent", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          message: "This is a mocked Agent response for testing",
          done: true,
        }),
      });
    });

    // Agent-Long mode: Trigger.dev (returns runId + token)
    await page.route("**/api/agent-long", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: "mock-run-id",
          publicAccessToken: "mock-public-access-token",
        }),
      });
    });
  }

  // Note: WorkOS and Convex are used with real test data
  // Mocking them would defeat the purpose of e2e testing
}

export async function mockWorkOSLogin(
  page: Page,
  email: string,
): Promise<void> {
  // Mock WorkOS OAuth callback for faster testing
  await page.route("**/login", async (route: Route) => {
    // Simulate successful login by setting cookies
    await page.context().addCookies([
      {
        name: "wos-session",
        value: "mock-session-token",
        domain: "localhost",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    await route.fulfill({
      status: 302,
      headers: {
        Location: "/",
      },
    });
  });
}

export async function clearMocks(page: Page): Promise<void> {
  await page.unroute("**/*");
}
