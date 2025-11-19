import { test, expect } from "@playwright/test";
import { ChatComponent } from "./page-objects";
import { setupChat } from "./helpers/test-helpers";
import { TIMEOUTS } from "./constants";

test.describe("Free Tier Restriction Tests", () => {
  test.use({ storageState: "e2e/.auth/free.json" });

  test("should show upgrade popover when attempting to attach file", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await chat.clickAttachButton();
    await chat.expectUpgradePopoverVisible();
    await chat.expectUpgradeNowButtonVisible();
  });

  test("should show Upgrade now button in file attachment popover", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await chat.clickAttachButton();
    await chat.expectUpgradePopoverVisible();

    const upgradeButton = page.getByRole("button", { name: "Upgrade now" });
    await expect(upgradeButton).toBeVisible();
    await expect(upgradeButton).toBeEnabled();
  });

  test("should redirect to pricing when clicking Upgrade now", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await chat.clickAttachButton();
    await chat.expectUpgradeNowButtonVisible();

    await chat.clickUpgradeNow();

    await page.waitForURL(/.*pricing.*/, { timeout: TIMEOUTS.MEDIUM });
    expect(page.url()).toMatch(/pricing/);
  });

  test("should show upgrade dialog when attempting to switch to Agent mode", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await chat.expectMode("ask");

    await page.getByRole("button", { name: /Ask/ }).click();

    const agentOption = page.getByRole("menuitem").filter({ hasText: "Agent" });
    await agentOption.click();

    await chat.expectUpgradeDialogVisible();
    await chat.expectUpgradePlanButtonVisible();
  });

  test("should show Upgrade plan button in Agent mode dialog", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await page.getByRole("button", { name: /Ask/ }).click();
    const agentOption = page.getByRole("menuitem").filter({ hasText: "Agent" });
    await agentOption.click();

    const upgradeButton = page.getByRole("button", { name: "Upgrade plan" });
    await expect(upgradeButton).toBeVisible();
    await expect(upgradeButton).toBeEnabled();
  });

  test("should redirect to pricing when clicking Upgrade plan from Agent dialog", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await page.getByRole("button", { name: /Ask/ }).click();
    const agentOption = page.getByRole("menuitem").filter({ hasText: "Agent" });
    await agentOption.click();

    await chat.expectUpgradePlanButtonVisible();
    await chat.clickUpgradePlan();

    await page.waitForURL(/.*pricing.*/, { timeout: TIMEOUTS.MEDIUM });
    expect(page.url()).toMatch(/pricing/);
  });

  test("should remain in Ask mode after dismissing Agent upgrade dialog", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await page.getByRole("button", { name: /Ask/ }).click();
    const agentOption = page.getByRole("menuitem").filter({ hasText: "Agent" });
    await agentOption.click();

    await chat.expectUpgradeDialogVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: TIMEOUTS.SHORT });
    await chat.expectMode("ask");
  });

  test("should show PRO badge on Agent mode option for free users", async ({
    page,
  }) => {
    const chat = await setupChat(page);

    await page.getByRole("button", { name: /Ask/ }).click();

    const agentOption = page.getByRole("menuitem").filter({ hasText: "Agent" });
    await expect(agentOption).toBeVisible();

    const proBadge = agentOption.locator("text=PRO");
    await expect(proBadge).toBeVisible();
  });

  test("should not allow file attachment for free tier", async ({ page }) => {
    const chat = await setupChat(page);

    await chat.clickAttachButton();
    await chat.expectUpgradePopoverVisible();

    const fileInput = page.locator('input[type="file"]');
    expect(await fileInput.count()).toBeGreaterThan(0);
  });
});
