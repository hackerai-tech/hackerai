import { Page, Locator, expect } from "@playwright/test";

export type SettingsTab =
  | "personalization"
  | "security"
  | "data-controls"
  | "agents"
  | "account";

export class SettingsDialog {
  private readonly dialog: Locator;
  private readonly closeButton: Locator;

  constructor(private page: Page) {
    this.dialog = page.getByTestId("settings-dialog");
    this.closeButton = page.getByRole("button", { name: /close/i }).first();
  }

  async expectVisible(): Promise<void> {
    await expect(this.dialog).toBeVisible();
  }

  async navigateToTab(tab: SettingsTab): Promise<void> {
    const tabButton = this.page.getByTestId(`settings-tab-${tab}`);
    await tabButton.click();
    await expect(tabButton).toHaveClass(/font-medium/);
  }

  async navigateToAllTabs(tabs: SettingsTab[]): Promise<void> {
    for (const tab of tabs) {
      await this.navigateToTab(tab);
    }
  }

  async close(): Promise<void> {
    const isVisible = await this.closeButton
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (isVisible) {
      await this.closeButton.click();
    }
  }

  async getMFAToggle(): Promise<Locator> {
    return this.page.getByTestId("mfa-toggle");
  }

  async getLogoutAllDevicesButton(): Promise<Locator> {
    return this.page.getByTestId("logout-button-all");
  }

  async expectMFAToggleVisible(): Promise<void> {
    await expect(this.page.getByTestId("mfa-toggle")).toBeVisible();
  }

  async expectLogoutAllDevicesVisible(): Promise<void> {
    await expect(this.page.getByTestId("logout-button-all")).toBeVisible();
  }
}
