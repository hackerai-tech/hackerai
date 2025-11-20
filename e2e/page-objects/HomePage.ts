import { Page, expect } from "@playwright/test";
import { BasePage } from "./BasePage";
import { SidebarComponent } from "./SidebarComponent";
import { UserMenuComponent } from "./UserMenuComponent";
import { SettingsDialog, SettingsTab } from "./SettingsDialog";

export class HomePage extends BasePage {
  readonly sidebar: SidebarComponent;
  readonly userMenu: UserMenuComponent;
  readonly settingsDialog: SettingsDialog;

  constructor(page: Page) {
    super(page);
    this.sidebar = new SidebarComponent(page);
    this.userMenu = new UserMenuComponent(page);
    this.settingsDialog = new SettingsDialog(page);
  }

  async openSettingsDialog(): Promise<void> {
    await this.userMenu.openSettings();
    await this.settingsDialog.expectVisible();
  }

  async navigateToSettingsTab(tab: SettingsTab): Promise<void> {
    await this.openSettingsDialog();
    await this.settingsDialog.navigateToTab(tab);
  }

  async verifySessionPersistence(): Promise<void> {
    await this.userMenu.expectVisible();
    await this.reload();
    await this.userMenu.expectVisible();
  }

  async verifyUpgradeButtonNotVisible(): Promise<void> {
    const upgradeButton = this.page.getByRole("button", {
      name: "Upgrade plan",
    });
    await expect(upgradeButton).not.toBeVisible();
  }
}
