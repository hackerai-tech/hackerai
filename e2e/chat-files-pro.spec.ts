import { test, expect } from "@playwright/test";
import { ChatComponent } from "./page-objects";
import {
  setupChat,
  sendMessageWithFileAndVerifyContent,
  attachTestFile,
} from "./helpers/test-helpers";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS, TEST_DATA } from "./constants";
import path from "path";

test.describe("File Attachment Tests - Pro and Ultra Tiers", () => {
  test.describe("Pro Tier", () => {
    test.use({ storageState: AUTH_STORAGE_PATHS.pro });

    test("should attach text file and AI reads content", async ({ page }) => {
      const chat = await setupChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "text",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.TEXT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach image and AI recognizes content", async ({ page }) => {
      const chat = await setupChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "image",
        "What do you see in this image? Answer in one word.",
        TEST_DATA.SECRETS.IMAGE_CONTENT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach PDF and AI reads content", async ({ page }) => {
      const chat = await setupChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "pdf",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.PDF,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach multiple files at once", async ({ page }) => {
      const chat = await setupChat(page);

      const textFile = path.join(process.cwd(), TEST_DATA.RESOURCES.TEXT_FILE);
      const imageFile = path.join(process.cwd(), TEST_DATA.RESOURCES.IMAGE);

      await chat.attachFiles([textFile, imageFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.txt");
      await chat.expectImageAttached("image.png");
    });

    test("should remove attached file", async ({ page }) => {
      const chat = await setupChat(page);

      await attachTestFile(chat, "text");
      await chat.removeAttachedFile(0);

      await chat.expectAttachedFileCount(0);
    });

    test("should send message with file attachment", async ({ page }) => {
      const chat = await setupChat(page);

      await attachTestFile(chat, "text");
      await chat.expectSendButtonEnabled();

      await chat.sendMessage("Describe this file");
      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(TIMEOUTS.AGENT);

      await expect(async () => {
        const messageCount = await chat.getMessageCount();
        expect(messageCount).toBeGreaterThanOrEqual(2);
      }).toPass({ timeout: TIMEOUTS.MEDIUM });
    });
  });

  test.describe("Ultra Tier", () => {
    test.use({ storageState: AUTH_STORAGE_PATHS.ultra });

    test("should attach text file and AI reads content", async ({ page }) => {
      const chat = await setupChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "text",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.TEXT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach image and AI recognizes content", async ({ page }) => {
      const chat = await setupChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "image",
        "What do you see in this image? Answer in one word.",
        TEST_DATA.SECRETS.IMAGE_CONTENT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach PDF and AI reads content", async ({ page }) => {
      const chat = await setupChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "pdf",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.PDF,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach multiple files at once", async ({ page }) => {
      const chat = await setupChat(page);

      const textFile = path.join(process.cwd(), TEST_DATA.RESOURCES.TEXT_FILE);
      const imageFile = path.join(process.cwd(), TEST_DATA.RESOURCES.IMAGE);

      await chat.attachFiles([textFile, imageFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.txt");
      await chat.expectImageAttached("image.png");
    });
  });
});
