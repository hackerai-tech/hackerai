import { test } from "@playwright/test";
import { TestUser } from "../fixtures/auth";
import { HomePage } from "../page-objects";
import { SettingsTab } from "../page-objects/SettingsDialog";

export const createCommonTests = (user: TestUser) => {
  return {
    testSessionPersistence: () => {
      test("Session Management - should persist session after page refresh", async ({
        page,
      }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.verifySessionPersistence();
      });
    },

    testOpenSettingsDialog: () => {
      test("Settings Dialog - should open settings dialog from user menu", async ({
        page,
      }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.openSettingsDialog();
      });
    },

    testSettingsTabs: () => {
      test("Settings Dialog - should navigate between settings tabs", async ({
        page,
      }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.openSettingsDialog();

        const tabs: SettingsTab[] = [
          "personalization",
          "security",
          "data-controls",
          "agents",
          "account",
        ];

        await homePage.settingsDialog.navigateToAllTabs(tabs);
      });
    },

    testMFAToggle: () => {
      test("Security Tab - should display MFA toggle", async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.navigateToSettingsTab("security");
        await homePage.settingsDialog.expectMFAToggleVisible();
      });
    },

    testLogoutAllDevices: () => {
      test("Security Tab - should display logout all devices button", async ({
        page,
      }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.navigateToSettingsTab("security");
        await homePage.settingsDialog.expectLogoutAllDevicesVisible();
      });
    },

    testTierBadge: (expectedTier: string) => {
      test(`UI State - should show ${expectedTier} badge`, async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.sidebar.verifySubscriptionTier(expectedTier);
      });
    },

    testNoUpgradeButton: () => {
      test("UI State - should NOT show upgrade button", async ({ page }) => {
        const homePage = new HomePage(page);
        await homePage.goto();
        await homePage.verifyUpgradeButtonNotVisible();
      });
    },
  };
};
