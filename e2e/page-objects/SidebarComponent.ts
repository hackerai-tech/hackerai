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
    return (await this.subscriptionBadge.textContent()) || "";
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
  async hasChatWithTitle(
    title: string,
    timeout: number = TIMEOUTS.MEDIUM,
  ): Promise<boolean> {
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
  async expectChatWithTitle(
    title: string,
    timeout: number = TIMEOUTS.MEDIUM,
  ): Promise<void> {
    const chatItem = await this.findChatByTitle(title);
    await expect(chatItem).toBeVisible({ timeout });
  }

  /**
   * Navigate to a chat by clicking its sidebar item.
   */
  async clickChatByTitle(title: string): Promise<void> {
    const chatItem = await this.findChatByTitle(title);
    await chatItem.click();
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

  /**
   * Open the chat options dropdown menu for a chat by title.
   * Waits for the menu to be visible.
   */
  async openChatOptionsByTitle(title: string): Promise<void> {
    const chatRow = await this.findChatByTitle(title);
    const optionsTrigger = chatRow.getByRole("button", {
      name: "Open conversation options",
    });
    await optionsTrigger.click();
    await expect(this.page.getByRole("menu")).toBeVisible({
      timeout: TIMEOUTS.SHORT,
    });
  }

  /**
   * Open the chat options dropdown menu for the chat at the given index (0-based position in the list).
   * Use this when titles are ambiguous or duplicated.
   */
  async openChatOptionsByIndex(index: number): Promise<void> {
    const chatItems = await this.getAllChatItems();
    const chatRow = chatItems.nth(index);
    const optionsTrigger = chatRow.getByRole("button", {
      name: "Open conversation options",
    });
    await optionsTrigger.click();
    await expect(this.page.getByRole("menu")).toBeVisible({
      timeout: TIMEOUTS.SHORT,
    });
  }

  /**
   * Pin a chat by title: open its options menu and click Pin.
   */
  async clickPin(title: string): Promise<void> {
    await this.openChatOptionsByTitle(title);
    await this.page.getByRole("menuitem", { name: "Pin" }).click();
  }

  /**
   * Unpin a chat by title: open its options menu and click Unpin.
   */
  async clickUnpin(title: string): Promise<void> {
    await this.openChatOptionsByTitle(title);
    await this.page.getByRole("menuitem", { name: "Unpin" }).click();
  }

  /**
   * Pin a chat by index (0-based position in the list). Use when titles are ambiguous.
   */
  async clickPinByIndex(index: number): Promise<void> {
    await this.openChatOptionsByIndex(index);
    await this.page.getByRole("menuitem", { name: "Pin" }).click();
  }

  /**
   * Unpin a chat by index (0-based position in the list). Use when titles are ambiguous.
   */
  async clickUnpinByIndex(index: number): Promise<void> {
    await this.openChatOptionsByIndex(index);
    await this.page.getByRole("menuitem", { name: "Unpin" }).click();
  }

  /**
   * Wait for the pin icon to appear next to a chat's title in the list (after pinning).
   */
  async expectPinIconVisible(
    title: string,
    timeout: number = TIMEOUTS.MEDIUM,
  ): Promise<void> {
    const chatRow = await this.findChatByTitle(title);
    await expect(chatRow.getByTestId("chat-item-pin-icon")).toBeVisible({
      timeout,
    });
  }
}
