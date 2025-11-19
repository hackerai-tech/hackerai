import { Page, expect, Locator } from "@playwright/test";
import path from "path";

export class ChatComponent {
  constructor(private page: Page) {}

  private get chatInput(): Locator {
    return this.page.getByTestId("chat-input");
  }

  private get sendButton(): Locator {
    return this.page.getByRole("button", { name: "Send message" });
  }

  private get stopButton(): Locator {
    return this.page.getByRole("button", { name: "Stop generation" });
  }

  private get attachButton(): Locator {
    return this.page.getByRole("button", { name: "Attach files" });
  }

  private get fileInput(): Locator {
    return this.page.locator('input[type="file"]');
  }

  private get messages(): Locator {
    return this.page.getByTestId("message");
  }

  private get streamingIndicator(): Locator {
    return this.page.getByTestId("streaming");
  }

  private get modeDropdown(): Locator {
    return this.page.getByRole("button", { name: /Ask|Agent/ });
  }

  private get askModeOption(): Locator {
    return this.page.getByRole("menuitem").filter({ hasText: "Ask" });
  }

  private get agentModeOption(): Locator {
    return this.page.getByRole("menuitem").filter({ hasText: "Agent" });
  }

  private get upgradeDialog(): Locator {
    return this.page.getByRole("dialog").filter({ hasText: "Upgrade plan" });
  }

  private get upgradePopover(): Locator {
    return this.page.getByRole("dialog").filter({ hasText: "Upgrade now" });
  }

  private get upgradeNowButton(): Locator {
    return this.page.getByRole("button", { name: "Upgrade now" });
  }

  private get upgradePlanButton(): Locator {
    return this.page.getByRole("button", { name: "Upgrade plan" });
  }

  private get attachedFiles(): Locator {
    return this.page.getByTestId("attached-file");
  }

  private get removeFileButtons(): Locator {
    return this.page.getByTestId("remove-file");
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

  async stopGeneration(): Promise<void> {
    await this.stopButton.click();
  }

  async attachFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);
    const fileName = filePath.split("/").pop() || "";
    await this.fileInput.setInputFiles(absolutePath);

    await this.waitForUploadComplete(fileName);
  }

  async attachFiles(filePaths: string[]): Promise<void> {
    const absolutePaths = filePaths.map((p) => path.resolve(p));
    await this.fileInput.setInputFiles(absolutePaths);

    await this.waitForUploadComplete();
  }

  async waitForUploadComplete(fileName?: string): Promise<void> {
    const uploadingText = this.page.getByText(
      "Uploading attachments to the computer...",
    );
    const isUploading = await uploadingText.isVisible().catch(() => false);
    if (isUploading) {
      await uploadingText.waitFor({ state: "hidden", timeout: 10000 });
    }

    if (fileName) {
      try {
        await this.page
          .getByRole("button", { name: fileName })
          .waitFor({ state: "visible", timeout: 5000 });
      } catch {
        await this.page
          .getByTestId("attached-file")
          .filter({ hasText: fileName })
          .waitFor({ state: "visible", timeout: 5000 });
      }
    }

    await expect(this.sendButton).toBeEnabled({ timeout: 5000 });
  }

  async clickAttachButton(): Promise<void> {
    await this.attachButton.click();
  }

  async removeAttachedFile(index: number = 0): Promise<void> {
    await this.removeFileButtons.nth(index).click();
  }

  async switchToAgentMode(): Promise<void> {
    await this.modeDropdown.click();
    await this.agentModeOption.click();
  }

  async switchToAskMode(): Promise<void> {
    await this.modeDropdown.click();
    await this.askModeOption.click();
  }

  async waitForResponse(timeout: number = 30000): Promise<void> {
    const isGenerating = await this.stopButton
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (isGenerating) {
      await this.stopButton.waitFor({ state: "hidden", timeout });
    }

    await this.messages.last().waitFor({ state: "visible", timeout: 10000 });
  }

  async waitForMessageCount(count: number, timeout: number = 5000): Promise<void> {
    await expect(this.messages).toHaveCount(count, { timeout });
  }

  async getMessageCount(timeout: number = 10000): Promise<number> {
    // Wait for at least one message to exist before counting
    await this.messages.first().waitFor({ state: "visible", timeout });
    return await this.messages.count();
  }

  async getLastMessageText(timeout: number = 10000): Promise<string> {
    const lastMessage = this.messages.last();
    await lastMessage.waitFor({ state: "visible", timeout });
    return await lastMessage.innerText();
  }

  async getMessageText(index: number): Promise<string> {
    return await this.messages.nth(index).innerText();
  }

  async expectMessageContains(text: string, timeout: number = 30000): Promise<void> {
    await expect(this.page.locator(`[data-testid="message"]:has-text("${text}")`))
      .toBeVisible({ timeout });
  }

  async expectStreamingVisible(): Promise<void> {
    const isGenerating = await this.stopButton
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const streamingVisible = await this.streamingIndicator
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(isGenerating || streamingVisible).toBe(true);
  }

  async expectStreamingNotVisible(timeout: number = 30000): Promise<void> {
    const stopButtonHidden = await this.stopButton
      .waitFor({ state: "hidden", timeout })
      .then(() => true)
      .catch(() => false);
    const streamingHidden = await this.streamingIndicator
      .waitFor({ state: "hidden", timeout })
      .then(() => true)
      .catch(() => false);

    expect(stopButtonHidden || streamingHidden).toBe(true);
  }

  async expectUpgradeDialogVisible(): Promise<void> {
    await expect(this.upgradeDialog).toBeVisible({ timeout: 5000 });
  }

  async expectUpgradePopoverVisible(): Promise<void> {
    await expect(this.upgradePopover).toBeVisible({ timeout: 5000 });
  }

  async expectUpgradeNowButtonVisible(): Promise<void> {
    await expect(this.upgradeNowButton).toBeVisible({ timeout: 5000 });
  }

  async expectUpgradePlanButtonVisible(): Promise<void> {
    await expect(this.upgradePlanButton).toBeVisible({ timeout: 5000 });
  }

  async clickUpgradeNow(): Promise<void> {
    await this.upgradeNowButton.click();
  }

  async clickUpgradePlan(): Promise<void> {
    await this.upgradePlanButton.click();
  }

  async expectImageAttached(fileName: string): Promise<void> {
    const imageButton = this.page.getByRole("button", { name: fileName });
    await expect(imageButton).toBeVisible();
    // Wait for send button to be enabled (upload complete)
    await expect(this.sendButton).toBeEnabled({ timeout: 5000 });
  }

  async expectNonImageFileAttached(fileName: string): Promise<void> {
    const fileDiv = this.attachedFiles.filter({ hasText: fileName });
    await expect(fileDiv).toBeVisible();
    // Wait for send button to be enabled (upload complete)
    await expect(this.sendButton).toBeEnabled({ timeout: 5000 });
  }

  async expectFileAttached(fileName: string): Promise<void> {
    const imageButton = this.page.getByRole("button", { name: fileName });
    const fileDiv = this.attachedFiles.filter({ hasText: fileName });

    const imageVisible = await imageButton.isVisible().catch(() => false);
    const fileVisible = await fileDiv.isVisible().catch(() => false);

    expect(imageVisible || fileVisible).toBe(true);
  }

  async expectAttachedFileCount(count: number): Promise<void> {
    await expect(this.attachedFiles).toHaveCount(count, { timeout: 5000 });
  }

  async expectChatInputVisible(): Promise<void> {
    await expect(this.chatInput).toBeVisible();
  }

  async expectSendButtonEnabled(): Promise<void> {
    await expect(this.sendButton).toBeEnabled();
  }

  async expectSendButtonDisabled(): Promise<void> {
    await expect(this.sendButton).toBeDisabled();
  }

  async getCurrentMode(): Promise<string> {
    const modeText = await this.modeDropdown.innerText();
    return modeText.includes("Agent") ? "agent" : "ask";
  }

  async expectMode(mode: "ask" | "agent"): Promise<void> {
    const currentMode = await this.getCurrentMode();
    expect(currentMode).toBe(mode);
  }
}
