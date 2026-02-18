import { Page, Locator, expect } from "@playwright/test";
import { TIMEOUTS } from "../constants";

export class SidebarComponent {
  private readonly subscriptionBadge: Locator;
  private readonly sidebarToggle: Locator;

  constructor(private page: Page) {
    this.subscriptionBadge = page.getByTestId("subscription-badge");
    this.sidebarToggle = page.getByTestId("sidebar-toggle");
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

  /**
   * Collapse the sidebar by clicking the toggle (when expanded).
   * Use for tests that need to close then reopen the sidebar.
   */
  async collapse(): Promise<void> {
    await expect(this.sidebarToggle).toBeVisible({ timeout: TIMEOUTS.MEDIUM });
    await this.sidebarToggle.click();
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
   * Uses .first() when multiple elements match (e.g. same chat in pinned + list).
   * Scrolls the item into view so the visible instance is clicked.
   */
  async clickChatByTitle(title: string): Promise<void> {
    const chatItem = (await this.findChatByTitle(title)).first();
    await chatItem.scrollIntoViewIfNeeded();
    await chatItem.click();
  }

  /**
   * Navigate to a chat by clicking the sidebar item with the given chat ID.
   * Use when multiple chats share the same title and you need the exact chat (e.g. from URL).
   */
  async clickChatById(chatId: string): Promise<void> {
    const chatItem = this.page.getByTestId(`chat-item-${chatId}`).first();
    await chatItem.scrollIntoViewIfNeeded();
    await chatItem.click();
  }

  /**
   * Find the sidebar menu item that navigates to the given chat URL and click it.
   * Uses the URL to resolve the chat ID and clicks the item with matching test ID.
   */
  async clickChatByUrl(url: string): Promise<void> {
    const chatId = new URL(url).pathname.replace(/^\/c\//, "");
    await this.clickChatById(chatId);
  }

  /**
   * Verify that a chat with the given ID appears in the sidebar.
   */
  async expectChatWithId(
    chatId: string,
    timeout: number = TIMEOUTS.MEDIUM,
  ): Promise<void> {
    const chatItem = this.page.getByTestId(`chat-item-${chatId}`).first();
    await expect(chatItem).toBeVisible({ timeout });
  }

  /**
   * Get the visible title of a sidebar chat row by its chat ID (from aria-label).
   */
  async getChatTitleById(chatId: string): Promise<string> {
    const chatItem = this.page.getByTestId(`chat-item-${chatId}`).first();
    const label = await chatItem.getAttribute("aria-label");
    const prefix = "Open chat: ";
    if (!label?.startsWith(prefix)) return label ?? "";
    return label.slice(prefix.length);
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
   * Wait for the sidebar chat list to finish loading after expand.
   * Use after expandIfCollapsed() when the list was previously collapsed (unmounted),
   * so the list has time to mount and load before e.g. getChatCount().
   */
  async waitForChatListReady(timeout: number = TIMEOUTS.MEDIUM): Promise<void> {
    await Promise.race([
      this.page
        .locator('[role="button"][aria-label^="Open chat:"]')
        .first()
        .waitFor({ state: "visible", timeout }),
      this.page
        .getByTestId("sidebar-chat-empty")
        .waitFor({ state: "visible", timeout }),
    ]);
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
   * Open the chat options dropdown menu for a chat by ID.
   * Use when the title may change; finds the sidebar item by test ID.
   */
  async openChatOptionsById(chatId: string): Promise<void> {
    const chatRow = this.page.getByTestId(`chat-item-${chatId}`).first();
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

  /**
   * Open the chat options dropdown menu for a chat by URL.
   * Extracts the chat ID from the URL and uses openChatOptionsById.
   */
  async openChatOptionsByUrl(url: string): Promise<void> {
    const chatId = new URL(url).pathname.replace(/^\/c\//, "");
    await this.openChatOptionsById(chatId);
  }

  /**
   * Pin a chat by URL: open its options menu and click Pin.
   */
  async clickPinByUrl(url: string): Promise<void> {
    await this.openChatOptionsByUrl(url);
    await this.page.getByRole("menuitem", { name: "Pin" }).click();
  }

  /**
   * Unpin a chat by URL: open its options menu and click Unpin.
   */
  async clickUnpinByUrl(url: string): Promise<void> {
    await this.openChatOptionsByUrl(url);
    await this.page.getByRole("menuitem", { name: "Unpin" }).click();
  }
}
