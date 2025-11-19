import { test } from "@playwright/test";
import { createCommonTests } from "./helpers/common-tests";
import { TEST_USERS } from "./fixtures/auth";

test.use({ storageState: "e2e/.auth/ultra.json" });

test.describe.serial("Ultra Tier Tests", () => {
  const commonTests = createCommonTests(TEST_USERS.ultra);

  commonTests.testSessionPersistence();
  commonTests.testOpenSettingsDialog();
  commonTests.testSettingsTabs();
  commonTests.testMFAToggle();
  commonTests.testLogoutAllDevices();
  commonTests.testTierBadge("Ultra");
  commonTests.testNoUpgradeButton();
});
