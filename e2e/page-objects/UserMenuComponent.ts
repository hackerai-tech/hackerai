import { Page, Locator, expect } from "@playwright/test";

export class UserMenuComponent {
  private readonly userMenuButton: Locator;
  private readonly settingsButton: Locator;

  constructor(private page: Page) {
    this.userMenuButton = page
      .getByTestId("user-menu-button")
      .or(page.getByTestId("user-menu-button-collapsed"));
    this.settingsButton = page.getByTestId("settings-button");
  }

  async getUserMenuButton(): Promise<Locator> {
    return this.userMenuButton;
  }

  async isVisible(): Promise<boolean> {
    return await this.userMenuButton.isVisible();
  }

  async expectVisible(): Promise<void> {
    await expect(this.userMenuButton).toBeVisible();
  }

  async openMenu(): Promise<void> {
    await this.userMenuButton.click();
  }

  async openSettings(): Promise<void> {
    await this.openMenu();
    await this.settingsButton.click();
  }
}
