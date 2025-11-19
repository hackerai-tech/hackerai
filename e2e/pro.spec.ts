import { test } from "@playwright/test";
import { createCommonTests } from "./helpers/common-tests";
import { TEST_USERS } from "./fixtures/auth";

test.use({ storageState: "e2e/.auth/pro.json" });

test.describe.serial("Pro Tier Tests", () => {
  const commonTests = createCommonTests(TEST_USERS.pro);

  commonTests.testSessionPersistence();
  commonTests.testOpenSettingsDialog();
  commonTests.testSettingsTabs();
  commonTests.testMFAToggle();
  commonTests.testLogoutAllDevices();
  commonTests.testTierBadge("Pro");
  commonTests.testNoUpgradeButton();
});
