import { expect, test } from "@playwright/test";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { setupChat } from "./helpers/test-helpers";
import { HomePage } from "./page-objects";

test.describe("Settings dialog first load", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.pro });

  test("waits for its bundle without showing an intermediate popup", async ({
    page,
  }) => {
    let releaseSettingsChunk: () => void = () => undefined;
    const settingsChunkGate = new Promise<void>((resolve) => {
      releaseSettingsChunk = resolve;
    });
    let settingsChunkDelayed = false;

    await page.route("**/_next/static/chunks/**/*.js", async (route) => {
      const url = decodeURIComponent(route.request().url());
      if (!settingsChunkDelayed && /SettingsDialog/i.test(url)) {
        settingsChunkDelayed = true;
        await settingsChunkGate;
      }
      await route.continue();
    });

    await setupChat(page);
    await expect.poll(() => settingsChunkDelayed).toBe(true);

    const home = new HomePage(page);
    await home.userMenu.openSettings();

    await expect(
      page.getByRole("status", { name: "Loading settings" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("settings-dialog")).toHaveCount(0);

    releaseSettingsChunk();
    const dialog = page.getByTestId("settings-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading settings" }),
    ).toHaveCount(0);
  });
});
