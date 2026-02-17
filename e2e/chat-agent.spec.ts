import { test, expect } from "@playwright/test";
import {
  setupChat,
  sendAndWaitForResponse,
  attachTestFile,
} from "./helpers/test-helpers";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS, TEST_DATA } from "./constants";

test.describe("Agent Mode Tests - Pro and Ultra Tiers", () => {
  test.describe("Pro Tier", () => {
    test.use({ storageState: AUTH_STORAGE_PATHS.pro });

    test("should generate markdown from image in Agent mode", async ({
      page,
    }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "image");

      await sendAndWaitForResponse(
        chat,
        "Generate a short markdown description of this image, save it to a file and share with me",
        TIMEOUTS.AGENT_LONG,
      );

      await chat.expectMessageContains(".md");
    });

    test("should resize image in Agent mode", async ({ page }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "image");

      await sendAndWaitForResponse(
        chat,
        "Create a 100x100px version of this image. Then share with me.",
        TIMEOUTS.AGENT_LONG,
      );

      const lastMessage = await chat.getLastMessageText();
      expect(lastMessage.toLowerCase()).toMatch(
        /100.*100|resize|created|saved/i,
      );
    });

    test("should accept file operations in Agent mode", async ({ page }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "text");

      await sendAndWaitForResponse(
        chat,
        "Read this file and tell me what word is in it",
        TIMEOUTS.AGENT,
      );

      await chat.expectMessageContains(TEST_DATA.SECRETS.TEXT);
    });

    test("should read PDF file in Agent mode", async ({ page }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "pdf");

      await sendAndWaitForResponse(
        chat,
        "Read this PDF file and tell me what word is in it",
        TIMEOUTS.AGENT_LONG,
      );

      await chat.expectMessageContains(TEST_DATA.SECRETS.PDF);
    });

    test("should handle multiple operations in Agent mode", async ({
      page,
    }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await sendAndWaitForResponse(
        chat,
        TEST_DATA.MESSAGES.MATH_SIMPLE,
        TIMEOUTS.AGENT,
      );
      await sendAndWaitForResponse(
        chat,
        TEST_DATA.MESSAGES.MATH_NEXT,
        TIMEOUTS.AGENT,
      );

      await expect(async () => {
        const messageCount = await chat.getMessageCount();
        expect(messageCount).toBeGreaterThanOrEqual(4);
      }).toPass({ timeout: TIMEOUTS.MEDIUM });
    });
  });

  test.describe("Ultra Tier", () => {
    test.use({ storageState: AUTH_STORAGE_PATHS.ultra });

    test("should generate markdown from image in Agent mode", async ({
      page,
    }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "image");

      await sendAndWaitForResponse(
        chat,
        "Generate a short markdown description of this image, save it to a file and share with me",
        TIMEOUTS.AGENT_LONG,
      );

      await chat.expectMessageContains(".md");
    });

    test("should resize image in Agent mode", async ({ page }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "image");

      await sendAndWaitForResponse(
        chat,
        "Create a 100x100px version of this image. Then share with me.",
        TIMEOUTS.AGENT_LONG,
      );

      const lastMessage = await chat.getLastMessageText();
      expect(lastMessage.toLowerCase()).toMatch(
        /100.*100|resize|created|saved/i,
      );
    });

    test("should accept file operations in Agent mode", async ({ page }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "text");

      await sendAndWaitForResponse(
        chat,
        "Read this file and tell me what word is in it",
        TIMEOUTS.AGENT,
      );

      await chat.expectMessageContains(TEST_DATA.SECRETS.TEXT);
    });

    test("should read PDF file in Agent mode", async ({ page }) => {
      const chat = await setupChat(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await attachTestFile(chat, "pdf");

      await sendAndWaitForResponse(
        chat,
        "Read this PDF file and tell me what word is in it",
        TIMEOUTS.AGENT_LONG,
      );

      await chat.expectMessageContains(TEST_DATA.SECRETS.PDF);
    });
  });
});
