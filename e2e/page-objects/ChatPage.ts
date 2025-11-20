import { Page, Locator, expect } from "@playwright/test";
import { BasePage } from "./BasePage";
import { ChatModeSelector } from "./ChatModeSelector";
import { FileAttachment } from "./FileAttachment";
import { UpgradeDialog } from "./UpgradeDialog";
import { TIMEOUTS } from "../constants";

export type ChatMode = "agent" | "ask";

export class ChatPage extends BasePage {
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly stopButton: Locator;
  readonly messagesContainer: Locator;

  readonly modeSelector: ChatModeSelector;
  readonly fileAttachment: FileAttachment;
  readonly upgradeDialog: UpgradeDialog;

  constructor(page: Page) {
    super(page);

    this.chatInput = page.getByTestId("chat-input");
    this.sendButton = page.getByRole("button", { name: /send message/i });
    this.stopButton = page.getByRole("button", { name: /stop generation/i });
    this.messagesContainer = page.locator('[data-testid="messages-container"]');

    this.modeSelector = new ChatModeSelector(page);
    this.fileAttachment = new FileAttachment(page);
    this.upgradeDialog = new UpgradeDialog(page);
  }

  async sendMessage(message: string): Promise<void> {
    await this.chatInput.fill(message);
    await this.sendButton.click();
  }

  async typeMessage(message: string): Promise<void> {
    await this.chatInput.fill(message);
  }

  async clickSend(): Promise<void> {
    await this.sendButton.click();
  }

  async sendMessageWithEnter(message: string): Promise<void> {
    await this.chatInput.fill(message);
    await this.chatInput.press("Enter");
  }

  async stopGeneration(): Promise<void> {
    await this.stopButton.click();
  }

  async waitForResponse(timeout: number = TIMEOUTS.MEDIUM): Promise<void> {
    const isGenerating = await this.stopButton
      .isVisible({ timeout: TIMEOUTS.STOP_BUTTON_CHECK })
      .catch(() => false);

    if (isGenerating) {
      await this.stopButton.waitFor({ state: "hidden", timeout });
    }

    await this.page.waitForSelector('[data-testid="assistant-message"]', {
      state: "visible",
      timeout: TIMEOUTS.SHORT,
    });
  }

  async getLastMessage(timeout: number = TIMEOUTS.SHORT): Promise<string> {
    const messages = this.page.locator('[data-testid="message-content"]');
    await messages.first().waitFor({ state: "visible", timeout });
    const count = await messages.count();
    if (count === 0) return "";
    return (await messages.nth(count - 1).textContent()) || "";
  }

  async getLastAssistantMessage(
    timeout: number = TIMEOUTS.SHORT,
  ): Promise<string> {
    const messages = this.page.locator('[data-testid="assistant-message"]');
    await messages.first().waitFor({ state: "visible", timeout });
    const count = await messages.count();
    if (count === 0) return "";
    return (await messages.nth(count - 1).textContent()) || "";
  }

  async getAllMessages(): Promise<string[]> {
    const messages = this.page.locator('[data-testid="message-content"]');
    const count = await messages.count();
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await messages.nth(i).textContent();
      if (text) texts.push(text);
    }
    return texts;
  }

  async verifyMessageVisible(text: string): Promise<void> {
    await expect(
      this.page.locator('[data-testid="message-content"]', { hasText: text }),
    ).toBeVisible();
  }

  async verifyAssistantMessageVisible(text: string): Promise<void> {
    await expect(
      this.page.locator('[data-testid="assistant-message"]', { hasText: text }),
    ).toBeVisible();
  }

  async verifySendButtonEnabled(): Promise<void> {
    await expect(this.sendButton).toBeEnabled();
  }

  async verifySendButtonDisabled(): Promise<void> {
    await expect(this.sendButton).toBeDisabled();
  }

  async verifyStopButtonVisible(): Promise<void> {
    await expect(this.stopButton).toBeVisible();
  }

  async verifyStopButtonNotVisible(): Promise<void> {
    await expect(this.stopButton).not.toBeVisible();
  }

  async clearInput(): Promise<void> {
    await this.chatInput.clear();
  }

  async getInputValue(): Promise<string> {
    return await this.chatInput.inputValue();
  }

  async switchMode(mode: ChatMode): Promise<void> {
    await this.modeSelector.selectMode(mode);
  }

  async getCurrentMode(): Promise<ChatMode> {
    return await this.modeSelector.getCurrentMode();
  }

  async verifyCurrentMode(mode: ChatMode): Promise<void> {
    await this.modeSelector.verifyCurrentMode(mode);
  }

  async attachFile(filePath: string): Promise<void> {
    await this.fileAttachment.attachFile(filePath);
  }

  async attachFiles(filePaths: string[]): Promise<void> {
    await this.fileAttachment.attachFiles(filePaths);
  }

  async removeAttachedFile(fileName: string): Promise<void> {
    await this.fileAttachment.removeFile(fileName);
  }

  async expectImageAttached(fileName: string): Promise<void> {
    await this.fileAttachment.expectImageAttached(fileName);
  }

  async expectFileAttached(fileName: string): Promise<void> {
    await this.fileAttachment.expectFileAttached(fileName);
  }

  async verifyFileAttached(fileName: string): Promise<void> {
    await this.fileAttachment.verifyFileAttached(fileName);
  }

  async verifyNoFilesAttached(): Promise<void> {
    await this.fileAttachment.verifyNoFilesAttached();
  }

  async getAttachedFileCount(): Promise<number> {
    return await this.fileAttachment.getAttachedFileCount();
  }
}
