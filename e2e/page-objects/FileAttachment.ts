import { Page, Locator, expect } from "@playwright/test";
import { TIMEOUTS } from "../constants";

export class FileAttachment {
  private readonly attachButton: Locator;
  private readonly fileInput: Locator;
  private readonly filePreviewContainer: Locator;
  private readonly uploadingStatus: Locator;

  constructor(private page: Page) {
    this.attachButton = page
      .locator('button[aria-label*="Attach"]')
      .or(page.locator('button:has-text("Attach")'));
    this.fileInput = page.locator('input[type="file"]');
    this.filePreviewContainer = page
      .locator('[data-testid="file-preview"]')
      .or(page.locator(".file-upload-preview"));
    this.uploadingStatus = page.locator("text=/uploading/i");
  }

  async attachFile(filePath: string): Promise<void> {
    const fileName = filePath.split("/").pop() || "";
    await this.fileInput.setInputFiles(filePath);
    await this.waitForUploadComplete(fileName);
    await this.verifyFileAttached(fileName);
  }

  async attachFiles(filePaths: string[]): Promise<void> {
    await this.fileInput.setInputFiles(filePaths);

    await this.waitForUploadComplete();

    for (const filePath of filePaths) {
      const fileName = filePath.split("/").pop() || "";
      await this.verifyFileAttached(fileName);
    }
  }

  async clickAttachButton(): Promise<void> {
    if (await this.attachButton.isVisible().catch(() => false)) {
      await this.attachButton.click();
    }
  }

  async removeFile(fileName: string): Promise<void> {
    const removeButton = this.page
      .locator(`[data-file-name="${fileName}"]`)
      .locator('button[aria-label*="Remove"]')
      .or(
        this.page.locator(`text="${fileName}"`).locator("..").locator("button"),
      );

    await removeButton.click();
    await this.verifyFileNotAttached(fileName);
  }

  async removeAllFiles(): Promise<void> {
    const removeButtons = this.page.locator(
      'button[aria-label*="Remove file"]',
    );
    const count = await removeButtons.count();

    for (let i = count - 1; i >= 0; i--) {
      await removeButtons.nth(i).click();
    }

    await this.verifyNoFilesAttached();
  }

  async expectImageAttached(fileName: string): Promise<void> {
    const imageButton = this.page.getByRole("button", { name: fileName });
    await expect(imageButton).toBeVisible();
    // Wait for send button to be enabled (upload complete)
    await expect(this.page.getByTestId("send-button")).toBeEnabled({
      timeout: TIMEOUTS.MEDIUM,
    });
  }

  async expectFileAttached(fileName: string): Promise<void> {
    const fileDiv = this.page
      .getByTestId("attached-file")
      .filter({ hasText: fileName });
    await expect(fileDiv).toBeVisible();
    // Wait for send button to be enabled (upload complete)
    await expect(this.page.getByTestId("send-button")).toBeEnabled({
      timeout: TIMEOUTS.SHORT,
    });
  }

  async verifyFileAttached(fileName: string): Promise<void> {
    const imageButton = this.page.getByRole("button", { name: fileName });
    const fileDiv = this.page
      .getByTestId("attached-file")
      .filter({ hasText: fileName });

    const imageVisible = await imageButton.isVisible().catch(() => false);
    const fileVisible = await fileDiv.isVisible().catch(() => false);

    expect(imageVisible || fileVisible).toBe(true);
  }

  async verifyFileNotAttached(fileName: string): Promise<void> {
    const fileItem = this.page
      .locator(`text="${fileName}"`)
      .or(this.page.locator(`[data-file-name="${fileName}"]`));
    await expect(fileItem).not.toBeVisible();
  }

  async verifyNoFilesAttached(): Promise<void> {
    await expect(this.filePreviewContainer).not.toBeVisible();
  }

  async verifyFileUploading(): Promise<void> {
    await expect(this.uploadingStatus).toBeVisible();
  }

  async waitForUploadComplete(fileName?: string): Promise<void> {
    const uploadingText = this.page.getByText(
      "Uploading attachments to the computer...",
    );
    const isUploading = await uploadingText.isVisible().catch(() => false);
    if (isUploading) {
      await uploadingText.waitFor({ state: "hidden", timeout: TIMEOUTS.SHORT });
    }

    if (fileName) {
      try {
        await this.page
          .getByRole("button", { name: fileName })
          .waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
      } catch {
        await this.page
          .getByTestId("attached-file")
          .filter({ hasText: fileName })
          .waitFor({ state: "visible", timeout: TIMEOUTS.SHORT });
      }
    }

    await expect(this.page.getByTestId("send-button")).toBeEnabled({
      timeout: TIMEOUTS.SHORT,
    });
  }

  async getAttachedFileCount(): Promise<number> {
    if (!(await this.filePreviewContainer.isVisible().catch(() => false))) {
      return 0;
    }

    const fileItems = this.page
      .locator('[data-testid="file-item"]')
      .or(this.page.locator(".file-preview-item"));
    return await fileItems.count();
  }

  async getAttachedFileNames(): Promise<string[]> {
    const fileItems = this.page
      .locator('[data-testid="file-item"]')
      .or(this.page.locator(".file-preview-item"));
    const count = await fileItems.count();
    const names: string[] = [];

    for (let i = 0; i < count; i++) {
      const text = await fileItems.nth(i).textContent();
      if (text) names.push(text.trim());
    }

    return names;
  }

  async verifyFileHasError(fileName: string): Promise<void> {
    const errorIndicator = this.page
      .locator(`text="${fileName}"`)
      .locator("..")
      .locator('[data-error="true"]')
      .or(
        this.page.locator(`text="${fileName}"`).locator("..").locator(".error"),
      );

    await expect(errorIndicator).toBeVisible();
  }

  async verifyFilePreviewVisible(): Promise<void> {
    await expect(this.filePreviewContainer).toBeVisible();
  }

  async verifyAttachButtonVisible(): Promise<void> {
    await expect(this.attachButton).toBeVisible();
  }

  async verifyAttachButtonEnabled(): Promise<void> {
    await expect(this.attachButton).toBeEnabled();
  }

  async verifyAttachButtonDisabled(): Promise<void> {
    await expect(this.attachButton).toBeDisabled();
  }
}
