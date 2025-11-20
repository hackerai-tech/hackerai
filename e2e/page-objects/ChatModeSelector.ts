import { Page, Locator, expect } from "@playwright/test";

export type ChatMode = "agent" | "ask";

export class ChatModeSelector {
  private readonly modeSelectorButton: Locator;
  private readonly modeDropdown: Locator;
  private readonly askModeOption: Locator;
  private readonly agentModeOption: Locator;

  constructor(private page: Page) {
    this.modeSelectorButton = page.getByRole("button", {
      name: /ask|agent/i,
    });
    this.modeDropdown = page.locator('[role="menu"]');
    this.askModeOption = page.locator('[role="menuitem"]', {
      has: page.locator('text="Ask"'),
    });
    this.agentModeOption = page.locator('[role="menuitem"]', {
      has: page.locator('text="Agent"'),
    });
  }

  async openModeDropdown(): Promise<void> {
    await this.modeSelectorButton.click();
    await expect(this.modeDropdown).toBeVisible();
  }

  async selectMode(mode: ChatMode): Promise<void> {
    await this.openModeDropdown();

    if (mode === "ask") {
      await this.askModeOption.click();
    } else {
      await this.agentModeOption.click();
    }

    await expect(this.modeDropdown).not.toBeVisible();
  }

  async selectAskMode(): Promise<void> {
    await this.selectMode("ask");
  }

  async selectAgentMode(): Promise<void> {
    await this.selectMode("agent");
  }

  async getCurrentMode(): Promise<ChatMode> {
    const buttonText = await this.modeSelectorButton.textContent();
    if (buttonText?.toLowerCase().includes("agent")) {
      return "agent";
    }
    return "ask";
  }

  async verifyCurrentMode(mode: ChatMode): Promise<void> {
    const currentMode = await this.getCurrentMode();
    expect(currentMode).toBe(mode);
  }

  async verifyModeSelectorVisible(): Promise<void> {
    await expect(this.modeSelectorButton).toBeVisible();
  }

  async verifyAskModeSelected(): Promise<void> {
    await this.verifyCurrentMode("ask");
  }

  async verifyAgentModeSelected(): Promise<void> {
    await this.verifyCurrentMode("agent");
  }

  async verifyAgentModeHasProBadge(): Promise<void> {
    await this.openModeDropdown();
    const proBadge = this.page
      .locator('[role="menuitem"]', {
        has: this.page.locator('text="Agent"'),
      })
      .locator('text="PRO"');
    await expect(proBadge).toBeVisible();
    await this.page.keyboard.press("Escape");
  }

  async verifyModeDropdownContainsOptions(options: ChatMode[]): Promise<void> {
    await this.openModeDropdown();

    for (const option of options) {
      const optionLocator =
        option === "ask" ? this.askModeOption : this.agentModeOption;
      await expect(optionLocator).toBeVisible();
    }

    await this.page.keyboard.press("Escape");
  }
}
