import { test as setup } from "@playwright/test";
import { authenticateUser, TEST_USERS } from "../fixtures/auth";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local
config({ path: resolve(process.cwd(), ".env.e2e") });

setup("authenticate free tier", async ({ page }) => {
  await authenticateUser(page, TEST_USERS.free);
});

setup("authenticate pro tier", async ({ page }) => {
  await authenticateUser(page, TEST_USERS.pro);
});

setup("authenticate ultra tier", async ({ page }) => {
  await authenticateUser(page, TEST_USERS.ultra);
});
