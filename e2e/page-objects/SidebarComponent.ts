import { Page, Locator, expect } from "@playwright/test";
import { TIMEOUTS } from "../constants";

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

  /**
   * Find a chat item in the sidebar by its title
   */
  async findChatByTitle(title: string): Promise<Locator> {
    return this.page.getByRole("button", { name: `Open chat: ${title}` });
  }

  /**
   * Check if a chat with the given title exists in the sidebar
   */
  async hasChatWithTitle(title: string, timeout: number = TIMEOUTS.MEDIUM): Promise<boolean> {
    try {
      const chatItem = await this.findChatByTitle(title);
      await chatItem.waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify that a chat with the given title appears in the sidebar
   */
  async expectChatWithTitle(title: string, timeout: number = TIMEOUTS.MEDIUM): Promise<void> {
    const chatItem = await this.findChatByTitle(title);
    await expect(chatItem).toBeVisible({ timeout });
  }

  /**
   * Get all chat items in the sidebar
   */
  async getAllChatItems(): Promise<Locator> {
    return this.page.locator('[role="button"][aria-label^="Open chat:"]');
  }

  /**
   * Get the count of chats in the sidebar
   */
  async getChatCount(): Promise<number> {
    const chatItems = await this.getAllChatItems();
    return await chatItems.count();
  }
}
