import { test, expect } from "@playwright/test";
import { ChatComponent } from "./page-objects";
import path from "path";

test.describe("File Attachment Tests - Pro and Ultra Tiers", () => {
  test.describe("Pro Tier", () => {
    test.use({ storageState: "e2e/.auth/pro.json" });

    test("should attach text file and AI reads content", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/secret.txt");
      await chat.attachFile(filePath);

      await chat.expectFileAttached("secret.txt");
      await chat.sendMessage("What is the secret word in the file?");

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("bazinga");
    });

    test("should attach image and AI recognizes content", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/image.png");
      await chat.attachFile(filePath);

      await chat.expectImageAttached("image.png");
      await chat.sendMessage(
        "What do you see in this image? Answer in one word.",
      );

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("duck");
    });

    test("should attach PDF and AI reads content", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/secret.pdf");
      await chat.attachFile(filePath);

      await chat.expectFileAttached("secret.pdf");
      await chat.sendMessage("What is the secret word in the file?");

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("hippo");
    });

    test("should attach multiple files at once", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const textFile = path.join(process.cwd(), "e2e/resource/secret.txt");
      const imageFile = path.join(process.cwd(), "e2e/resource/image.png");

      await chat.attachFiles([textFile, imageFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.txt");
      await chat.expectImageAttached("image.png");
    });

    test("should remove attached file", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/secret.txt");
      await chat.attachFile(filePath);

      await chat.expectFileAttached("secret.txt");
      await chat.removeAttachedFile(0);

      await chat.expectAttachedFileCount(0);
    });

    test("should send message with file attachment", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/secret.txt");
      await chat.attachFile(filePath);

      await chat.expectFileAttached("secret.txt");
      await chat.expectSendButtonEnabled();

      await chat.sendMessage("Describe this file");
      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await expect(async () => {
        const messageCount = await chat.getMessageCount();
        expect(messageCount).toBeGreaterThanOrEqual(2);
      }).toPass({ timeout: 10000 });
    });
  });

  test.describe("Ultra Tier", () => {
    test.use({ storageState: "e2e/.auth/ultra.json" });

    test("should attach text file and AI reads content", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/secret.txt");
      await chat.attachFile(filePath);

      await chat.expectFileAttached("secret.txt");
      await chat.sendMessage("What is the secret word in the file?");

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("bazinga");
    });

    test("should attach image and AI recognizes content", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/image.png");
      await chat.attachFile(filePath);

      await chat.expectImageAttached("image.png");
      await chat.sendMessage(
        "What do you see in this image? Answer in one word.",
      );

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("duck");
    });

    test("should attach PDF and AI reads content", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const filePath = path.join(process.cwd(), "e2e/resource/secret.pdf");
      await chat.attachFile(filePath);

      await chat.expectFileAttached("secret.pdf");
      await chat.sendMessage("What is the secret word in the file?");

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("hippo");
    });

    test("should attach multiple files at once", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      const textFile = path.join(process.cwd(), "e2e/resource/secret.txt");
      const imageFile = path.join(process.cwd(), "e2e/resource/image.png");

      await chat.attachFiles([textFile, imageFile]);

      await chat.expectAttachedFileCount(2);
      await chat.expectFileAttached("secret.txt");
      await chat.expectImageAttached("image.png");
    });
  });
});
