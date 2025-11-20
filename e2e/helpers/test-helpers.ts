import { Page } from "@playwright/test";
import { ChatComponent } from "../page-objects";
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
