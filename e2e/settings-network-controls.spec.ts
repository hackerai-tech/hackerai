import { expect, test } from "@playwright/test";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { setupChat } from "./helpers/test-helpers";
import { HomePage } from "./page-objects";

test.describe("Cloud Agent network settings", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.pro });

  test("shows simple outbound controls for paid users", async ({ page }) => {
    await setupChat(page);
    await new HomePage(page).navigateToSettingsTab("agents");

    await expect(
      page.getByRole("heading", { name: "Cloud Agent network" }),
    ).toBeVisible();
    await expect(page.getByText("Inbound access")).toHaveCount(0);
    await expect(page.getByLabel("Outbound access")).toContainText(
      /Unrestricted|Allow only listed destinations|Block listed destinations/,
    );
    await expect(
      page.getByText("Local and desktop environments are unchanged."),
    ).toBeVisible();
  });
});

test.describe("Cloud Agent network settings entitlement", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.free });

  test("keeps paid network controls hidden for free users", async ({
    page,
  }) => {
    await setupChat(page);
    await new HomePage(page).navigateToSettingsTab("agents");

    await expect(
      page.getByRole("heading", { name: "Cloud Agent network" }),
    ).toHaveCount(0);
  });
});
