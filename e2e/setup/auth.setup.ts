import { test as setup } from "@playwright/test";
import { authenticateUser, TEST_USERS } from "../fixtures/auth";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local
config({ path: resolve(process.cwd(), ".env.e2e") });

const authFiles = {
  free: "e2e/.auth/free.json",
  pro: "e2e/.auth/pro.json",
  ultra: "e2e/.auth/ultra.json",
};

setup("authenticate free tier", async ({ page }) => {
  await authenticateUser(page, TEST_USERS.free);
  await page.context().storageState({ path: authFiles.free });
});

setup("authenticate pro tier", async ({ page }) => {
  await authenticateUser(page, TEST_USERS.pro);
  await page.context().storageState({ path: authFiles.pro });
});

setup("authenticate ultra tier", async ({ page }) => {
  await authenticateUser(page, TEST_USERS.ultra);
  await page.context().storageState({ path: authFiles.ultra });
});
