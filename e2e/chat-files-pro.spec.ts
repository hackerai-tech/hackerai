import { test, expect, type Page } from "@playwright/test";
import { ChatComponent } from "./page-objects";
import {
  setupChat,
  sendMessageWithFileAndVerifyContent,
  attachTestFile,
  sendAndWaitForResponse,
} from "./helpers/test-helpers";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS, TEST_DATA } from "./constants";
import path from "path";
import fs from "fs";

test.setTimeout(TIMEOUTS.AGENT_LONG);

async function writeJpegFixture(
  page: Page,
  outputPath: string,
): Promise<string> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 12;
    canvas.height = 12;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas context unavailable");
    context.fillStyle = "#111827";
    context.fillRect(0, 0, 12, 12);
    context.fillStyle = "#22c55e";
    context.fillRect(3, 3, 6, 6);
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
  });

  fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
  return outputPath;
}

async function setupFileChat(page: Page): Promise<ChatComponent> {
  return setupChat(page, { refreshEntitlements: true });
}

test.describe("File Attachment Tests - Pro and Ultra Tiers", () => {
  test.describe("Pro Tier", () => {
    test.use({ storageState: AUTH_STORAGE_PATHS.pro });

    test("should attach text file and AI reads content", async ({ page }) => {
      const chat = await setupFileChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "text",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.TEXT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach image and AI recognizes content", async ({ page }) => {
      const chat = await setupFileChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "image",
        "What do you see in this image? Answer in one word.",
        TEST_DATA.SECRETS.IMAGE_CONTENT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach PDF and AI reads content", async ({ page }) => {
      const chat = await setupFileChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "pdf",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.PDF,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach markdown and CSV files and AI reads content", async ({
      page,
    }) => {
      const chat = await setupFileChat(page);

      const markdownFile = path.join(
        process.cwd(),
        TEST_DATA.RESOURCES.MARKDOWN_FILE,
      );
      const csvFile = path.join(process.cwd(), TEST_DATA.RESOURCES.CSV_FILE);

      await chat.attachFiles([markdownFile, csvFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.md");
      await chat.expectFileAttached("secret.csv");

      await sendAndWaitForResponse(
        chat,
        "What are the secret words in the attached markdown and CSV files?",
        TIMEOUTS.AGENT,
      );

      await chat.expectMessageContains(TEST_DATA.SECRETS.MARKDOWN);
      await chat.expectMessageContains(TEST_DATA.SECRETS.CSV);
    });

    test("should attach jpg and jpeg images", async ({ page }, testInfo) => {
      const chat = await setupFileChat(page);

      const jpgFile = await writeJpegFixture(
        page,
        testInfo.outputPath("sample.jpg"),
      );
      const jpegFile = await writeJpegFixture(
        page,
        testInfo.outputPath("sample.jpeg"),
      );

      await chat.attachFiles([jpgFile, jpegFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("sample.jpg");
      await chat.expectFileAttached("sample.jpeg");

      await sendAndWaitForResponse(
        chat,
        "Confirm the two attached images uploaded.",
        TIMEOUTS.AGENT,
      );
    });

    test("should attach multiple files at once", async ({ page }) => {
      const chat = await setupFileChat(page);

      const textFile = path.join(process.cwd(), TEST_DATA.RESOURCES.TEXT_FILE);
      const imageFile = path.join(process.cwd(), TEST_DATA.RESOURCES.IMAGE);

      await chat.attachFiles([textFile, imageFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.txt");
      await chat.expectImageAttached("image.png");
    });

    test("should remove attached file", async ({ page }) => {
      const chat = await setupFileChat(page);

      await attachTestFile(chat, "text");
      await chat.removeAttachedFile(0);

      await chat.expectAttachedFileCount(0);
    });

    test("should send message with file attachment", async ({ page }) => {
      const chat = await setupFileChat(page);

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
      const chat = await setupFileChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "text",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.TEXT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach image and AI recognizes content", async ({ page }) => {
      const chat = await setupFileChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "image",
        "What do you see in this image? Answer in one word.",
        TEST_DATA.SECRETS.IMAGE_CONTENT,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach PDF and AI reads content", async ({ page }) => {
      const chat = await setupFileChat(page);

      await sendMessageWithFileAndVerifyContent(
        chat,
        "pdf",
        "What is the secret word in the file?",
        TEST_DATA.SECRETS.PDF,
        TIMEOUTS.AGENT,
      );
    });

    test("should attach multiple files at once", async ({ page }) => {
      const chat = await setupFileChat(page);

      const textFile = path.join(process.cwd(), TEST_DATA.RESOURCES.TEXT_FILE);
      const imageFile = path.join(process.cwd(), TEST_DATA.RESOURCES.IMAGE);

      await chat.attachFiles([textFile, imageFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.txt");
      await chat.expectImageAttached("image.png");
    });
  });
});
