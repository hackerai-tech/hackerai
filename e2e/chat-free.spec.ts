import { test, expect } from "@playwright/test";
import { setupChat, sendAndWaitForResponse } from "./helpers/test-helpers";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS, TEST_DATA } from "./constants";
import { SidebarComponent } from "./page-objects/SidebarComponent";

test.describe("Free Tier Simple Chat Tests", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.free });

  test("should handle multiple messages in conversation", async ({ page }) => {
    const chat = await setupChat(page);
    const sidebar = new SidebarComponent(page);

    await sendAndWaitForResponse(
      chat,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TIMEOUTS.MEDIUM,
    );

    await sendAndWaitForResponse(
      chat,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.MEDIUM,
    );

    await expect(async () => {
      const messageCount = await chat.getMessageCount();
      expect(messageCount).toBeGreaterThanOrEqual(4);
    }).toPass({ timeout: TIMEOUTS.MEDIUM });

    // Ensure sidebar is expanded to see chat items
    await sidebar.expandIfCollapsed();

    // Wait for chat to appear in sidebar and verify a title was set
    await expect(async () => {
      const chatItems = await sidebar.getAllChatItems();
      const chatCount = await chatItems.count();
      expect(chatCount).toBeGreaterThan(0);

      // Get the first chat item and verify it has a title (not empty or "New Chat")
      const firstChat = chatItems.first();
      const ariaLabel = await firstChat.getAttribute("aria-label");

      // Extract title from aria-label (format: "Open chat: {title}")
      const titleMatch = ariaLabel?.match(/^Open chat: (.+)$/);
      const sidebarTitle = titleMatch ? titleMatch[1] : "";

      // Verify title is set and not empty or "New Chat"
      expect(sidebarTitle).toBeTruthy();
      expect(sidebarTitle).not.toBe("New Chat");

      // Verify the chat is visible in sidebar
      await expect(firstChat).toBeVisible();

      // Get the chat title from the header
      const headerTitle = await chat.getChatHeaderTitle();

      // Compare the sidebar title with the header title
      expect(headerTitle).toBeTruthy();
      expect(headerTitle.slice(0, 15)).toBe(sidebarTitle.slice(0, 15));
    }).toPass({ timeout: TIMEOUTS.MEDIUM });
  });
});
