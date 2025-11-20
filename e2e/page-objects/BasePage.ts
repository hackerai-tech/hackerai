import { Page } from "@playwright/test";

export abstract class BasePage {
  constructor(protected page: Page) {}

  async goto(path: string = "/"): Promise<void> {
    await this.page.goto(path);
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }
}
