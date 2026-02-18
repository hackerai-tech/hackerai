import { Page, expect, Locator } from "@playwright/test";
import path from "path";
import { TIMEOUTS } from "../constants";

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
    return this.page.locator(
      '[data-testid="user-message"], [data-testid="assistant-message"]',
    );
  }

  private get streamingIndicator(): Locator {
    return this.page.getByTestId("streaming");
  }

  private get modeDropdown(): Locator {
    return this.page.getByRole("button", { name: /Ask|Agent/ });
  }

  private get askModeOption(): Locator {
    return this.page.getByTestId("mode-ask");
  }

  private get agentModeOption(): Locator {
    return this.page.getByTestId("mode-agent");
  }

  private get agentLongModeOption(): Locator {
    return this.page.getByTestId("mode-agent-long");
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
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.MEDIUM });
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
    if (fileName) {
      const isImage = fileName.match(/\.(png|jpg|jpeg|gif|webp)$/i);
      if (isImage) {
        await this.page
          .getByRole("button", { name: fileName })
          .waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
      } else {
        await this.page
          .getByTestId("attached-file")
          .filter({ hasText: fileName })
          .waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
      }
    }

    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.SHORT });
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

  async switchToAgentLongMode(): Promise<void> {
    await this.modeDropdown.click();
    await this.agentLongModeOption.click();
  }

  async switchToAskMode(): Promise<void> {
    await this.modeDropdown.click();
    await this.askModeOption.click();
  }

  async waitForResponse(timeout: number = TIMEOUTS.MEDIUM): Promise<void> {
    const isGenerating = await this.stopButton
      .isVisible({ timeout: TIMEOUTS.STOP_BUTTON_CHECK })
      .catch(() => false);

    if (isGenerating) {
      await this.stopButton.waitFor({ state: "hidden", timeout });
    }

    await this.messages
      .last()
      .waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
  }

  async getMessageCount(
    timeout: number = TIMEOUTS.SHORT,
    options?: { allowEmpty?: boolean },
  ): Promise<number> {
    if (!options?.allowEmpty) {
      // Wait for at least one message to exist before counting
      await this.messages.first().waitFor({ state: "visible", timeout });
    }
    return await this.messages.count();
  }

  async getLastMessageText(timeout: number = TIMEOUTS.SHORT): Promise<string> {
    const lastMessage = this.messages.last();
    await lastMessage.waitFor({ state: "visible", timeout });
    return await lastMessage.innerText();
  }

  async expectMessageContains(
    text: string,
    timeout: number = TIMEOUTS.MEDIUM,
  ): Promise<void> {
    await expect(
      this.page
        .locator(
          `[data-testid="user-message"], [data-testid="assistant-message"]`,
        )
        .filter({ hasText: text }),
    ).toBeVisible({ timeout });
  }

  async expectStreamingVisible(): Promise<void> {
    const isGenerating = await this.stopButton
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);
    const streamingVisible = await this.streamingIndicator
      .isVisible({ timeout: TIMEOUTS.SHORT })
      .catch(() => false);

    expect(isGenerating || streamingVisible).toBe(true);
  }

  async expectStreamingNotVisible(
    timeout: number = TIMEOUTS.AGENT,
  ): Promise<void> {
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
    await expect(this.upgradeDialog).toBeVisible({ timeout: TIMEOUTS.SHORT });
  }

  async expectUpgradePopoverVisible(): Promise<void> {
    await expect(this.upgradePopover).toBeVisible({ timeout: TIMEOUTS.SHORT });
  }

  async expectUpgradeNowButtonVisible(): Promise<void> {
    await expect(this.upgradeNowButton).toBeVisible({
      timeout: TIMEOUTS.SHORT,
    });
  }

  async expectUpgradePlanButtonVisible(): Promise<void> {
    await expect(this.upgradePlanButton).toBeVisible({
      timeout: TIMEOUTS.SHORT,
    });
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
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.SHORT });
  }

  async expectNonImageFileAttached(fileName: string): Promise<void> {
    const fileDiv = this.attachedFiles.filter({ hasText: fileName });
    await expect(fileDiv).toBeVisible();
    // Wait for send button to be enabled (upload complete)
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.MEDIUM });
  }

  async expectFileAttached(fileName: string): Promise<void> {
    const imageButton = this.page.getByRole("button", { name: fileName });
    const fileDiv = this.attachedFiles.filter({ hasText: fileName });

    const imageVisible = await imageButton.isVisible().catch(() => false);
    const fileVisible = await fileDiv.isVisible().catch(() => false);

    expect(imageVisible || fileVisible).toBe(true);
  }

  async expectAttachedFileCount(count: number): Promise<void> {
    await expect(this.attachedFiles).toHaveCount(count, {
      timeout: TIMEOUTS.MEDIUM,
    });
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
    if (modeText.includes("Agent-Long")) return "agent-long";
    if (modeText.includes("Agent")) return "agent";
    return "ask";
  }

  async expectMode(mode: "ask" | "agent" | "agent-long"): Promise<void> {
    const currentMode = await this.getCurrentMode();
    expect(currentMode).toBe(mode);
  }

  /**
   * Get the chat title from the header
   */
  async getChatHeaderTitle(timeout: number = TIMEOUTS.SHORT): Promise<string> {
    // The chat title is displayed in a div with text-lg font-medium classes
    // It contains a span with the title text, and may include icons (like Split icon for branched chats)
    // We need to get the text content excluding SVG icons
    const titleContainer = this.page.locator("div.text-lg.font-medium").first();

    await titleContainer.waitFor({ state: "visible", timeout });

    // Get all text nodes, excluding SVG elements
    // The title is in a span, and we want to exclude any SVG icons
    const titleText = await titleContainer.evaluate((el) => {
      // Clone the element to avoid modifying the original
      const clone = el.cloneNode(true) as HTMLElement;
      // Remove all SVG elements
      clone.querySelectorAll("svg").forEach((svg) => svg.remove());
      // Get the text content
      return clone.textContent?.trim() || "";
    });

    return titleText;
  }
}
