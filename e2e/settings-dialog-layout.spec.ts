import { expect, test } from "@playwright/test";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { setupChat } from "./helpers/test-helpers";
import { HomePage } from "./page-objects";

test.describe("Settings dialog loading layout", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.pro });

  test("keeps its desktop dimensions stable while the dialog bundle loads", async ({
    page,
  }) => {
    await setupChat(page);

    await page.route("**/_next/static/chunks/**/*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });

    const home = new HomePage(page);
    await home.userMenu.openSettings();

    const loadingShell = page.getByTestId("settings-dialog-loading-shell");
    await expect(loadingShell).toBeVisible();
    const loadingBox = await loadingShell.boundingBox();
    expect(loadingBox).not.toBeNull();

    const dialog = page.getByTestId("settings-dialog");
    await expect(dialog).toBeVisible();
    await expect(loadingShell).toBeHidden();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();

    expect(Math.abs(loadingBox!.width - dialogBox!.width)).toBeLessThan(2);
    expect(Math.abs(loadingBox!.height - dialogBox!.height)).toBeLessThan(2);
  });
});
