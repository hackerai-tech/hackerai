import { Page, Locator, expect } from "@playwright/test";
import { TIMEOUTS } from "../constants";

export class UpgradeDialog {
  private readonly dialog: Locator;
  private readonly dialogTitle: Locator;
  private readonly dialogDescription: Locator;
  private readonly upgradeButton: Locator;
  private readonly upgradeNowButton: Locator;
  private readonly upgradePlanButton: Locator;
  private readonly closeButton: Locator;

  constructor(private page: Page) {
    this.dialog = page.locator('[role="dialog"]');
    this.dialogTitle = this.dialog
      .locator('[role="heading"]')
      .or(this.dialog.locator("h2, .dialog-title"));
    this.dialogDescription = this.dialog
      .locator(".dialog-description")
      .or(this.dialog.locator("p"));
    this.upgradeButton = page.getByRole("button", { name: /upgrade/i });
    this.upgradeNowButton = page.getByRole("button", { name: /upgrade now/i });
    this.upgradePlanButton = page.getByRole("button", {
      name: /upgrade plan/i,
    });
    this.closeButton = this.dialog
      .locator('button[aria-label*="Close"]')
      .or(this.dialog.locator('button:has-text("×")'));
  }

  async verifyDialogVisible(): Promise<void> {
    await expect(this.dialog).toBeVisible();
  }

  async verifyDialogNotVisible(): Promise<void> {
    await expect(this.dialog).not.toBeVisible();
  }

  async verifyDialogTitle(expectedTitle: string): Promise<void> {
    await expect(this.dialogTitle).toHaveText(expectedTitle);
  }

  async verifyDialogTitleContains(text: string): Promise<void> {
    await expect(this.dialogTitle).toContainText(text);
  }

  async verifyDialogDescriptionContains(text: string): Promise<void> {
    await expect(this.dialogDescription).toContainText(text);
  }

  async clickUpgradeNow(): Promise<void> {
    await this.upgradeNowButton.click();
  }

  async clickUpgradePlan(): Promise<void> {
    await this.upgradePlanButton.click();
  }

  async clickAnyUpgradeButton(): Promise<void> {
    if (await this.upgradeNowButton.isVisible().catch(() => false)) {
      await this.upgradeNowButton.click();
    } else if (await this.upgradePlanButton.isVisible().catch(() => false)) {
      await this.upgradePlanButton.click();
    } else {
      await this.upgradeButton.first().click();
    }
  }

  async closeDialog(): Promise<void> {
    if (await this.closeButton.isVisible().catch(() => false)) {
      await this.closeButton.click();
    } else {
      await this.page.keyboard.press("Escape");
    }
    await this.verifyDialogNotVisible();
  }

  async verifyUpgradeButtonVisible(): Promise<void> {
    const hasUpgradeButton =
      (await this.upgradeNowButton.isVisible().catch(() => false)) ||
      (await this.upgradePlanButton.isVisible().catch(() => false)) ||
      (await this.upgradeButton
        .first()
        .isVisible()
        .catch(() => false));

    expect(hasUpgradeButton).toBe(true);
  }

  async verifyDialogContent(expectedContent: {
    title?: string;
    titleContains?: string;
    descriptionContains?: string;
  }): Promise<void> {
    await this.verifyDialogVisible();

    if (expectedContent.title) {
      await this.verifyDialogTitle(expectedContent.title);
    }

    if (expectedContent.titleContains) {
      await this.verifyDialogTitleContains(expectedContent.titleContains);
    }

    if (expectedContent.descriptionContains) {
      await this.verifyDialogDescriptionContains(
        expectedContent.descriptionContains,
      );
    }

    await this.verifyUpgradeButtonVisible();
  }

  async waitForDialogToAppear(): Promise<void> {
    await expect(this.dialog).toBeVisible({ timeout: TIMEOUTS.SHORT });
  }

  async waitForDialogToDisappear(): Promise<void> {
    await expect(this.dialog).not.toBeVisible({ timeout: TIMEOUTS.SHORT });
  }

  async verifyAgentModeUpgradeDialog(): Promise<void> {
    await this.verifyDialogContent({
      titleContains: "Upgrade",
      descriptionContains: "Agent mode",
    });
  }

  async verifyFileUploadUpgradeDialog(): Promise<void> {
    await this.verifyDialogContent({
      titleContains: "Upgrade",
    });
  }

  async getDialogTitle(): Promise<string> {
    return (await this.dialogTitle.textContent()) || "";
  }

  async getDialogDescription(): Promise<string> {
    return (await this.dialogDescription.textContent()) || "";
  }
}
