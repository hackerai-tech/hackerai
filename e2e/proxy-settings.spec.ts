import { expect, test } from "@playwright/test";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";

test.use({
  storageState: AUTH_STORAGE_PATHS.pro,
  viewport: { width: 1440, height: 1000 },
});

test("paid users can open Cloud Agent proxy settings", async ({ page }) => {
  await page.goto("/");
  await page
    .getByTestId("user-menu-button")
    .or(page.getByTestId("user-menu-button-collapsed"))
    .click();
  await page.getByTestId("settings-button").click();
  await page.getByTestId("settings-tab-agents").click();

  await expect(
    page.getByRole("heading", { name: "Cloud Agent Proxy" }),
  ).toBeVisible();
  const proxyServer = page.getByLabel("Proxy Server", { exact: true });
  if (!(await proxyServer.isVisible())) {
    await page.getByLabel("Enable Cloud Agent proxy").click();
  }
  await expect(proxyServer).toBeVisible();
  await expect(page.getByLabel("Port", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Save & Test|Save Changes/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Authentication & Advanced" }).click();
  await expect(page.getByLabel(/Username/)).toBeVisible();
  await expect(
    page.getByText(/Web Search and URL Reader stay direct/),
  ).toBeVisible();
  await expect(
    page.getByText(/Build Error|Unhandled Runtime Error|Application error/),
  ).toHaveCount(0);
});
