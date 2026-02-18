import { Page, expect } from "@playwright/test";
import { ChatComponent } from "../page-objects";
import { SidebarComponent } from "../page-objects/SidebarComponent";
import path from "path";
import { TEST_DATA, TIMEOUTS } from "../constants";

/**
 * Common test helper functions to reduce duplication
 */

/**
 * Send a message and wait for AI response
 */
export async function sendAndWaitForResponse(
  chat: ChatComponent,
  message: string,
  timeout: number = TIMEOUTS.LONG,
): Promise<void> {
  await chat.sendMessage(message);
  await chat.expectStreamingVisible();
  await chat.expectStreamingNotVisible(timeout);
}

/**
 * Attach a file by name and wait for upload completion
 */
export async function attachTestFile(
  chat: ChatComponent,
  fileName: "image" | "text" | "pdf",
): Promise<void> {
  const fileMap = {
    image: TEST_DATA.RESOURCES.IMAGE,
    text: TEST_DATA.RESOURCES.TEXT_FILE,
    pdf: TEST_DATA.RESOURCES.PDF_FILE,
  };

  const filePath = path.join(process.cwd(), fileMap[fileName]);
  await chat.attachFile(filePath);

  // Wait for upload based on file type
  const fileNameMap = {
    image: "image.png",
    text: "secret.txt",
    pdf: "secret.pdf",
  };

  if (fileName === "image") {
    await chat.expectImageAttached(fileNameMap[fileName]);
  } else {
    await chat.expectFileAttached(fileNameMap[fileName]);
  }
}

/**
 * Common setup for chat tests
 */
export async function setupChat(page: Page): Promise<ChatComponent> {
  await page.goto("/");
  return new ChatComponent(page);
}

function chatIdFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\/c\//, "");
}

/**
 * Create two chats with distinct messages and return stable URLs/IDs for navigation.
 * Chat A is created first (messageA), then new chat + messageB for chat B.
 * Use urlA/urlB or chatIdA/chatIdB for switching; titles can change after creation.
 */
export async function createTwoChats(
  page: Page,
  messageA: string,
  messageB: string,
  timeout: number = TIMEOUTS.MEDIUM,
): Promise<{ urlA: string; urlB: string; chatIdA: string; chatIdB: string }> {
  const chat = await setupChat(page);
  const sidebar = new SidebarComponent(page);

  await sendAndWaitForResponse(chat, messageA, timeout);
  await sidebar.expandIfCollapsed();
  await expect(async () => {
    const items = await sidebar.getAllChatItems();
    expect(await items.count()).toBeGreaterThan(0);
  }).toPass({ timeout });

  const urlA = page.url();
  const chatIdA = chatIdFromUrl(urlA);

  await page
    .getByRole("button", { name: /new chat/i })
    .first()
    .click();
  await page
    .waitForURL(/\/(c\/[^/]+)?$/, { timeout: TIMEOUTS.SHORT })
    .catch(() => {});

  const chatB = new ChatComponent(page);
  await sendAndWaitForResponse(chatB, messageB, timeout);

  const urlB = page.url();
  const chatIdB = chatIdFromUrl(urlB);

  return { urlA, urlB, chatIdA, chatIdB };
}

/**
 * Send message with file and verify AI reads content
 */
export async function sendMessageWithFileAndVerifyContent(
  chat: ChatComponent,
  fileType: "text" | "pdf" | "image",
  question: string,
  expectedContent: string,
  timeout: number = TIMEOUTS.AGENT,
): Promise<void> {
  await attachTestFile(chat, fileType);
  await sendAndWaitForResponse(chat, question, timeout);
  await chat.expectMessageContains(expectedContent);
}
