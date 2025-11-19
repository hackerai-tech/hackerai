import { test } from "@playwright/test";
import { createCommonTests } from "./helpers/common-tests";
import { TEST_USERS } from "./fixtures/auth";

test.use({ storageState: "e2e/.auth/free.json" });

test.describe.serial("Free Tier Tests", () => {
  const commonTests = createCommonTests(TEST_USERS.free);

  commonTests.testSessionPersistence();
  commonTests.testOpenSettingsDialog();
  commonTests.testSettingsTabs();
  commonTests.testMFAToggle();
  commonTests.testLogoutAllDevices();
  commonTests.testTierBadge("Free");
});
