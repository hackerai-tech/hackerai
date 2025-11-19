import { Page, expect } from "@playwright/test";
import { authenticateUser, TestUser } from "../fixtures/auth";

export const getUserMenuButton = (page: Page) => {
  return page
    .getByTestId("user-menu-button")
    .or(page.getByTestId("user-menu-button-collapsed"));
};

export const ensureAuthenticated = async (page: Page, user: TestUser) => {
  // Always call authenticateUser - it has built-in caching
  // First test: Will perform actual login and cache cookies
  // Subsequent tests: Will load cached cookies into context and skip login
  await authenticateUser(page, user);
};

export const openSettingsDialog = async (page: Page) => {
  const userMenuButton = getUserMenuButton(page);
  await userMenuButton.click();
  await page.getByTestId("settings-button").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
};

export const navigateToSettingsTab = async (page: Page, tab: string) => {
  await openSettingsDialog(page);
  await page.getByTestId(`settings-tab-${tab}`).click();
};

export const closeDialog = async (page: Page) => {
  const closeButton = page.getByRole("button", { name: /close/i }).first();
  if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.click();
  }
};
