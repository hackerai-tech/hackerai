import { test, expect } from "@playwright/test";
import { ChatComponent } from "./page-objects";
import path from "path";

test.describe("Agent Mode Tests - Pro and Ultra Tiers", () => {
  test.describe("Pro Tier", () => {
    test.use({ storageState: "e2e/.auth/pro.json" });

    test("should switch to Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.expectMode("ask");
      await chat.switchToAgentMode();
      await chat.expectMode("agent");
    });

    test("should switch back to Ask mode from Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await chat.switchToAskMode();
      await chat.expectMode("ask");
    });

    test("should generate markdown from image in Agent mode", async ({
      page,
    }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      const filePath = path.join(process.cwd(), "e2e/resource/image.png");
      await chat.attachFile(filePath);

      await chat.expectImageAttached("image.png");
      await chat.sendMessage(
        "Generate a short markdown description of this image, save it to a file and share with me",
      );

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(90000);

      await chat.expectMessageContains(".md");
    });

    test("should resize image in Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      const filePath = path.join(process.cwd(), "e2e/resource/image.png");
      await chat.attachFile(filePath);

      await chat.expectImageAttached("image.png");
      await chat.sendMessage(
        "Create a 100x100px version of this image using: pip3 install pillow && python3 -c \"from PIL import Image; img = Image.open('/home/user/upload/image.png'); img_resized = img.resize((100, 100)); img_resized.save('/home/user/resized_image.png')\". Then share with me.",
      );

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(90000);

      const lastMessage = await chat.getLastMessageText();
      expect(lastMessage.toLowerCase()).toMatch(
        /100.*100|resize|created|saved/i,
      );
    });

    test("should accept file operations in Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      const filePath = path.join(process.cwd(), "e2e/resource/secret.txt");
      await chat.attachFile(filePath);

      await chat.sendMessage("Read this file and tell me what word is in it");

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("bazinga");
    });

    test("should handle multiple operations in Agent mode", async ({
      page,
    }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await chat.sendMessage("What is 2+2?");
      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.sendMessage("What is 3+3?");
      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await expect(async () => {
        const messageCount = await chat.getMessageCount();
        expect(messageCount).toBeGreaterThanOrEqual(4);
      }).toPass({ timeout: 10000 });
    });
  });

  test.describe("Ultra Tier", () => {
    test.use({ storageState: "e2e/.auth/ultra.json" });

    test("should switch to Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.expectMode("ask");
      await chat.switchToAgentMode();
      await chat.expectMode("agent");
    });

    test("should switch back to Ask mode from Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      await chat.switchToAskMode();
      await chat.expectMode("ask");
    });

    test("should generate markdown from image in Agent mode", async ({
      page,
    }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      const filePath = path.join(process.cwd(), "e2e/resource/image.png");
      await chat.attachFile(filePath);

      await chat.expectImageAttached("image.png");
      await chat.sendMessage(
        "Generate a short markdown description of this image, save it to a file and share with me",
      );

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(90000);

      await chat.expectMessageContains(".md");
    });

    test("should resize image in Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      const filePath = path.join(process.cwd(), "e2e/resource/image.png");
      await chat.attachFile(filePath);

      await chat.expectImageAttached("image.png");
      await chat.sendMessage(
        "Create a 100x100px version of this image using: pip3 install pillow && python3 -c \"from PIL import Image; img = Image.open('/home/user/upload/image.png'); img_resized = img.resize((100, 100)); img_resized.save('/home/user/resized_image.png')\". Then share with me.",
      );

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(90000);

      const lastMessage = await chat.getLastMessageText();
      expect(lastMessage.toLowerCase()).toMatch(
        /100.*100|resize|created|saved/i,
      );
    });

    test("should accept file operations in Agent mode", async ({ page }) => {
      await page.goto("/");
      const chat = new ChatComponent(page);

      await chat.switchToAgentMode();
      await chat.expectMode("agent");

      const filePath = path.join(process.cwd(), "e2e/resource/secret.txt");
      await chat.attachFile(filePath);

      await chat.sendMessage("Read this file and tell me what word is in it");

      await chat.expectStreamingVisible();
      await chat.expectStreamingNotVisible(120000);

      await chat.expectMessageContains("bazinga");
    });
  });
});
