import { Page, Locator, expect } from "@playwright/test";

export class SidebarComponent {
  private readonly subscriptionBadge: Locator;
  private readonly sidebarToggle: Locator;

  constructor(private page: Page) {
    this.subscriptionBadge = page.getByTestId("subscription-badge");
    this.sidebarToggle = page.getByTestId("sidebar-toggle");
  }

  async getSubscriptionBadge(): Promise<Locator> {
    return this.subscriptionBadge;
  }

  async expandIfCollapsed(): Promise<void> {
    const badgeVisible = await this.subscriptionBadge
      .isVisible()
      .catch(() => false);

    if (!badgeVisible) {
      await this.sidebarToggle.click();
      await expect(this.subscriptionBadge).toBeVisible();
    }
  }

  async getSubscriptionTier(): Promise<string> {
    await this.expandIfCollapsed();
    return await this.subscriptionBadge.textContent() || "";
  }

  async verifySubscriptionTier(expectedTier: string): Promise<void> {
    await this.expandIfCollapsed();
    await expect(this.subscriptionBadge).toHaveText(expectedTier);
  }
}
