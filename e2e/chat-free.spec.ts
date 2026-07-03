import { test, expect } from "@playwright/test";
import { setupChat, sendAndWaitForResponse } from "./helpers/test-helpers";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS, TEST_DATA } from "./constants";
import { SidebarComponent } from "./page-objects/SidebarComponent";

test.describe("Free Tier Simple Chat Tests", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.free });

  test("should handle multiple messages in conversation", async ({ page }) => {
    test.setTimeout(TIMEOUTS.AGENT_LONG);

    const chat = await setupChat(page);
    const sidebar = new SidebarComponent(page);

    await sendAndWaitForResponse(
      chat,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TIMEOUTS.LONG,
    );
    await chat.expectMessageContains("4", TIMEOUTS.LONG);

    await sendAndWaitForResponse(
      chat,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.LONG,
    );
    await chat.expectMessageContains("6", TIMEOUTS.LONG);

    // Ensure sidebar is expanded to see chat items
    await sidebar.expandIfCollapsed();

    // Wait for chat to appear in sidebar and verify a title was set
    await expect(async () => {
      const chatItems = await sidebar.getAllChatItems();
      const chatCount = await chatItems.count();
      expect(chatCount).toBeGreaterThan(0);

      const chatId = new URL(page.url()).pathname.replace(/^\/c\//, "");
      expect(chatId).toBeTruthy();

      await sidebar.expectChatWithId(chatId);
      const sidebarTitle = await sidebar.getChatTitleById(chatId);

      // Verify title is set and not empty or "New Chat"
      expect(sidebarTitle).toBeTruthy();
      expect(sidebarTitle).not.toBe("New Chat");

      // Verify the chat is visible in sidebar
      await sidebar.expectChatWithId(chatId);

      // Get the chat title from the header
      const headerTitle = await chat.getChatHeaderTitle();

      // Compare the sidebar title with the header title
      expect(headerTitle).toBeTruthy();
      expect(headerTitle.slice(0, 15)).toBe(sidebarTitle.slice(0, 15));
    }).toPass({ timeout: TIMEOUTS.MEDIUM });
  });
});
