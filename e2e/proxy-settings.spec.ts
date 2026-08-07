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
    page.getByRole("heading", { name: "Cloud Agent proxy" }),
  ).toBeVisible();
  await expect(page.getByLabel("Host", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save proxy" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test connection" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Web search and URL-reading tools are not included/),
  ).toBeVisible();
  await expect(
    page.getByText(/Build Error|Unhandled Runtime Error|Application error/),
  ).toHaveCount(0);
});
