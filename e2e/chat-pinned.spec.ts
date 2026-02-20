import { test, expect, type Page } from "@playwright/test";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS } from "./constants";
import { SidebarComponent } from "./page-objects/SidebarComponent";
import { ChatComponent } from "@/e2e/page-objects";

const SHARED_CHAT_NAMES = [
  "Pin Test Chat A",
  "Pin Test Chat B",
  "Pin Test Chat C",
  "Pin Test Chat D",
];

test.describe("Pinned Chats", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.free });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(TIMEOUTS.LONG);
    const context = await browser.newContext({
      storageState: AUTH_STORAGE_PATHS.free,
    });
    const page = await context.newPage();
    await page.goto("/");
    const chat = new ChatComponent(page);
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);
    const initialCount = await sidebar.getChatCount();

    if (initialCount >= SHARED_CHAT_NAMES.length) {
      await page.close();
      await context.close();
      return;
    }

    const chatsToCreate = SHARED_CHAT_NAMES.length - initialCount;

    // Create all chats quickly without waiting for AI responses
    for (let i = 0; i < chatsToCreate; i++) {
      const name = SHARED_CHAT_NAMES[initialCount + i];

      if (i > 0 || initialCount === 0) {
        await page.getByRole("button", { name: "Start new chat" }).click();
        await page.waitForTimeout(300);
      }

      await chat.sendMessage(name);
    }

    // Wait once for all chats to appear in sidebar
    await expect(async () => {
      await sidebar.expandIfCollapsed();
      await waitForChatsToAppear(page);
      const count = await sidebar.getChatCount();
      expect(count).toBeGreaterThanOrEqual(SHARED_CHAT_NAMES.length);
    }).toPass({ timeout: TIMEOUTS.LONG });

    await page.close();
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const sidebar = new SidebarComponent(page);
    await unpinAllChats(sidebar, page);
  });

  /**
   * Unpin all chats that currently show a pin icon (so tests start from clean state).
   */
  async function unpinAllChats(
    sidebar: SidebarComponent,
    page: Page,
  ): Promise<void> {
    // Ensure sidebar is expanded and loaded
    await sidebar.expandIfCollapsed();
    await waitForChatsToAppear(page);

    // Repeat until there are no more pin icons
    while ((await page.getByTestId("chat-item-pin-icon").count()) > 0) {
      // Get all chat items
      const items = await sidebar.getAllChatItems();
      const itemCount = await items.count();

      // Go through items from LAST to FIRST
      for (let i = itemCount - 1; i >= 0; i--) {
        const row = items.nth(i);
        const pinIcon = row.getByTestId("chat-item-pin-icon");
        const isVisible = await pinIcon.isVisible().catch(() => false);

        if (isVisible) {
          // Unpin this item
          await sidebar.clickUnpinByIndex(i);

          // Wait for menu to close
          await expect(page.getByRole("menu")).not.toBeVisible({
            timeout: TIMEOUTS.MEDIUM,
          });

          // Verify the pin icon is removed from THIS item
          await expect(pinIcon).not.toBeVisible({
            timeout: TIMEOUTS.MEDIUM,
          });

          // Break to check if more pins exist
          break;
        }
      }
    }
  }

  async function waitForChatsToAppear(page: Page): Promise<void> {
    const locator = page
      .getByTestId("sidebar-chat-list")
      .or(page.getByTestId("sidebar-chat-empty"));
    await expect(locator).toBeVisible({ timeout: TIMEOUTS.LONG });
  }

  /**
   * Get chat titles in current sidebar order (first = top of list).
   */
  async function getOrderedChatTitles(
    sidebar: SidebarComponent,
  ): Promise<string[]> {
    const items = await sidebar.getAllChatItems();
    const count = await items.count();
    const titles: string[] = [];
    for (let i = 0; i < count; i++) {
      const label = await items.nth(i).getAttribute("aria-label");
      const m = label?.match(/^Open chat: (.+)$/);
      titles.push(m ? m[1] : "");
    }
    return titles;
  }

  /**
   * Get chat URLs in current sidebar order (first = top of list).
   * Extracts chat IDs from test IDs and constructs full URLs.
   */
  async function getOrderedChatUrls(
    sidebar: SidebarComponent,
    page: Page,
  ): Promise<string[]> {
    const items = await sidebar.getAllChatItems();
    const count = await items.count();
    const baseUrl = new URL(page.url()).origin;
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const testId = await item.getAttribute("data-testid");
      if (testId && testId.startsWith("chat-item-")) {
        const chatId = testId.replace("chat-item-", "");
        urls.push(`${baseUrl}/c/${chatId}`);
      }
    }
    return urls;
  }

  test("should pin a chat and show Unpin in menu", async ({ page }) => {
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);

    await sidebar.clickPinByIndex(0);

    await sidebar.openChatOptionsByIndex(0);
    await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
  });

  test("should unpin a chat and show Pin in menu", async ({ page }) => {
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);

    // Step 1-2: Open menu of first item and click Pin
    await sidebar.openChatOptionsByIndex(0);
    await page.getByRole("menuitem", { name: "Pin" }).click();

    // Step 3: Wait for backend to update - menu should show "Unpin"
    await expect(async () => {
      await sidebar.openChatOptionsByIndex(0);
      await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible({
        timeout: TIMEOUTS.SHORT,
      });
      await page.keyboard.press("Escape");
    }).toPass({ timeout: TIMEOUTS.MEDIUM });

    // Step 4-5: Open menu again and click Unpin
    await sidebar.openChatOptionsByIndex(0);
    await page.getByRole("menuitem", { name: "Unpin" }).click();

    // Step 6-7: Wait for backend to update - menu should show "Pin"
    await expect(async () => {
      await sidebar.openChatOptionsByIndex(0);
      await expect(
        page.getByRole("menuitem", { name: "Pin", exact: true }),
      ).toBeVisible({
        timeout: TIMEOUTS.SHORT,
      });
      await page.keyboard.press("Escape");
    }).toPass({ timeout: TIMEOUTS.MEDIUM });
  });

  test("pinned chats appear first in sidebar", async ({ page }) => {
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);

    const urls = await getOrderedChatUrls(sidebar, page);
    const urlTwo = urls[1];

    // Pin urlTwo and wait for backend to confirm it worked
    await sidebar.openChatOptionsByUrl(urlTwo);
    await page.getByRole("menuitem", { name: "Pin" }).click();

    await expect(async () => {
      await sidebar.openChatOptionsByUrl(urlTwo);
      await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible({
        timeout: TIMEOUTS.SHORT,
      });
      await page.keyboard.press("Escape");
    }).toPass({ timeout: TIMEOUTS.MEDIUM });

    // Now verify urlTwo is at the top
    const updatedUrls = await getOrderedChatUrls(sidebar, page);
    expect(updatedUrls[0]).toBe(urlTwo);
  });

  test("pin order is preserved in sidebar", async ({ page }) => {
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);

    let urls = await getOrderedChatUrls(sidebar, page);
    const url1 = urls[2];
    const url2 = urls[1];
    const url3 = urls[0];

    // Pin in order: 2nd, 1st, 3rd -> sidebar order should be url2, url1, url3
    await sidebar.clickPinByUrl(url2);
    await page.waitForTimeout(200);
    await sidebar.clickPinByUrl(url1);
    await page.waitForTimeout(200);
    await sidebar.clickPinByUrl(url3);

    await expect(async () => {
      urls = await getOrderedChatUrls(sidebar, page);
      expect(urls[0]).toBe(url2);
      expect(urls[1]).toBe(url1);
      expect(urls[2]).toBe(url3);
    }).toPass({ timeout: TIMEOUTS.MEDIUM });
  });

  test("max pins (3) shows error toast", async ({ page }) => {
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);

    await sidebar.clickPinByIndex(0);
    await expect(page.getByTestId("chat-item-pin-icon")).toHaveCount(1, {
      timeout: TIMEOUTS.SHORT,
    });
    await sidebar.clickPinByIndex(1);
    await expect(page.getByTestId("chat-item-pin-icon")).toHaveCount(2, {
      timeout: TIMEOUTS.SHORT,
    });
    await sidebar.clickPinByIndex(2);
    await expect(page.getByTestId("chat-item-pin-icon")).toHaveCount(3, {
      timeout: TIMEOUTS.SHORT,
    });
    await sidebar.clickPinByIndex(3);

    await expect(
      page.getByText("You can pin at most 3 chats", { exact: false }),
    ).toBeVisible({ timeout: TIMEOUTS.SHORT });

    await sidebar.openChatOptionsByIndex(3);
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "Pin", exact: true }),
    ).toBeVisible();
  });

  test("unpin moves chat to top of unpinned list", async ({ page }) => {
    const sidebar = new SidebarComponent(page);
    await sidebar.expandIfCollapsed();

    await waitForChatsToAppear(page);

    const titlesBeforePin = await getOrderedChatTitles(sidebar);

    // Pin chat at index 1
    await sidebar.openChatOptionsByIndex(1);
    await page.getByRole("menuitem", { name: "Pin" }).click();

    // Wait for backend to update - menu should show "Unpin" and order should change
    await expect(async () => {
      const titlesAfterPin = await getOrderedChatTitles(sidebar);
      expect(titlesAfterPin[0]).toBe(titlesBeforePin[1]);
      expect(titlesAfterPin[1]).toBe(titlesBeforePin[0]);

      await sidebar.openChatOptionsByIndex(0);
      await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible({
        timeout: TIMEOUTS.SHORT,
      });
      await page.keyboard.press("Escape");
    }).toPass({ timeout: TIMEOUTS.MEDIUM });

    // Unpin the chat
    await sidebar.openChatOptionsByIndex(0);
    await page.getByRole("menuitem", { name: "Unpin" }).click();

    // Wait for backend to update - menu should show "Pin" and unpinned chat stays at top
    await expect(async () => {
      const titlesAfterUnpin = await getOrderedChatTitles(sidebar);
      expect(titlesAfterUnpin[0]).toBe(titlesBeforePin[1]);
      expect(titlesAfterUnpin[1]).toBe(titlesBeforePin[0]);

      await sidebar.openChatOptionsByIndex(0);
      await expect(
        page.getByRole("menuitem", { name: "Pin", exact: true }),
      ).toBeVisible({
        timeout: TIMEOUTS.SHORT,
      });
      await page.keyboard.press("Escape");
    }).toPass({ timeout: TIMEOUTS.MEDIUM });
  });
});
