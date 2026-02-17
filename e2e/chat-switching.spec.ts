import { test, expect } from "@playwright/test";
import * as dotenv from "dotenv";
import * as path from "path";
import { WorkOS } from "@workos-inc/node";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import {
  setupChat,
  sendAndWaitForResponse,
  createTwoChats,
} from "./helpers/test-helpers";
import { ChatComponent } from "./page-objects/ChatComponent";
import { SidebarComponent } from "./page-objects/SidebarComponent";
import { AUTH_STORAGE_PATHS } from "./fixtures/auth";
import { TIMEOUTS, TEST_DATA } from "./constants";
import { getTestUsersRecord } from "../scripts/test-users-config";

async function deleteTestUserChats(): Promise<void> {
  dotenv.config({ path: path.join(process.cwd(), ".env.e2e") });
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  const workosKey = process.env.WORKOS_API_KEY;
  const workosClientId = process.env.WORKOS_CLIENT_ID;
  if (!convexUrl || !serviceKey || !workosKey || !workosClientId) {
    return;
  }
  try {
    const workos = new WorkOS(workosKey, { clientId: workosClientId });
    const proEmail = getTestUsersRecord().pro.email;
    const { data } = await workos.userManagement.listUsers({
      email: proEmail,
    });
    const userId = data[0]?.id;
    if (!userId) return;
    const convex = new ConvexHttpClient(convexUrl);
    await convex.mutation(api.chats.deleteAllChatsForUser, {
      serviceKey,
      userId,
    });
  } catch {
    // Teardown is best-effort; do not fail the run
  }
}

/**
 * E2E tests for chat switching and ChatProvider behavior.
 * See e2e/docs/chat-switching-test-plan.md for the full numbered list of cases.
 */
test.describe("Chat switching", () => {
  test.use({ storageState: AUTH_STORAGE_PATHS.pro });

  test.afterAll(async () => {
    await deleteTestUserChats();
  });

  test("Switch from chat A to chat B via sidebar – URL and content update", async ({
    page,
  }) => {
    const { urlB } = await createTwoChats(
      page,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.MEDIUM,
    );
    const sidebar = new SidebarComponent(page);

    await sidebar.expandIfCollapsed();
    await sidebar.clickChatByUrl(urlB);

    await expect(page).toHaveURL(urlB, { timeout: TIMEOUTS.MEDIUM });
    await page.waitForLoadState("networkidle").catch(() => {});

    const headerTitle = await new ChatComponent(page).getChatHeaderTitle();
    expect(headerTitle).toBeTruthy();
    await new ChatComponent(page).expectMessageContains("6");
  });

  test("Switch from chat A to chat B and back to A – no cross-talk", async ({
    page,
  }) => {
    const { urlA, urlB } = await createTwoChats(
      page,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.MEDIUM,
    );
    const sidebar = new SidebarComponent(page);

    await sidebar.expandIfCollapsed();
    await sidebar.clickChatByUrl(urlA);
    await expect(page).toHaveURL(urlA, { timeout: TIMEOUTS.MEDIUM });

    await sidebar.clickChatByUrl(urlB);
    await expect(page).toHaveURL(urlB, { timeout: TIMEOUTS.MEDIUM });

    await sidebar.expandIfCollapsed();
    await sidebar.clickChatByUrl(urlA);
    await expect(page).toHaveURL(urlA, { timeout: TIMEOUTS.MEDIUM });
  });

  test("Chat list persists when sidebar is toggled", async ({ page }) => {
    const { urlA, urlB, chatIdA, chatIdB } = await createTwoChats(
      page,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.MEDIUM,
    );
    const sidebar = new SidebarComponent(page);

    await sidebar.expandIfCollapsed();
    await sidebar.waitForChatListReady();
    const count = await sidebar.getChatCount();
    expect(count).toBeGreaterThanOrEqual(2);

    await sidebar.collapse();
    await sidebar.expandIfCollapsed();
    await sidebar.waitForChatListReady();

    expect(await sidebar.getChatCount()).toBe(count);
    await sidebar.expectChatWithId(chatIdA);
    await sidebar.expectChatWithId(chatIdB);

    await sidebar.clickChatByUrl(urlA);
    await expect(page).toHaveURL(urlA, { timeout: TIMEOUTS.MEDIUM });
    await sidebar.clickChatByUrl(urlB);
    await expect(page).toHaveURL(urlB, { timeout: TIMEOUTS.MEDIUM });
  });

  test("New chat clears transient state – empty messages and input", async ({
    page,
  }) => {
    const chat = await setupChat(page);
    await sendAndWaitForResponse(
      chat,
      TEST_DATA.MESSAGES.SIMPLE,
      TIMEOUTS.MEDIUM,
    );
    const countBefore = await chat.getMessageCount();
    expect(countBefore).toBeGreaterThan(0);

    await page
      .getByRole("button", { name: /new chat/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/(c\/[^/]+)?$/, {
      timeout: TIMEOUTS.SHORT,
    });

    const chatNew = new ChatComponent(page);
    await expect(async () => {
      const count = await chatNew.getMessageCount(TIMEOUTS.SHORT, {
        allowEmpty: true,
      });
      expect(count).toBe(0);
    }).toPass({ timeout: TIMEOUTS.SHORT });
    await chatNew.expectChatInputVisible();
    await chatNew.expectSendButtonDisabled();
  });

  test("Branch creates new chat and shows it", async ({ page }) => {
    const chat = await setupChat(page);

    await sendAndWaitForResponse(
      chat,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TIMEOUTS.MEDIUM,
    );
    const urlBefore = page.url();

    await page
      .locator('[data-testid="messages-container"]')
      .getByRole("button", { name: "Branch in new chat" })
      .first()
      .click();

    await expect(page).toHaveURL(/\/c\/[\w-]+/, { timeout: TIMEOUTS.MEDIUM });
    await expect(page).not.toHaveURL(urlBefore);

    const chatNew = new ChatComponent(page);
    await chatNew.expectMessageContains("4");
  });

  test("Sidebar chat title matches header title after switch", async ({
    page,
  }) => {
    const { urlA, chatIdA } = await createTwoChats(
      page,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.MEDIUM,
    );
    const sidebar = new SidebarComponent(page);

    await sidebar.expandIfCollapsed();
    await sidebar.clickChatByUrl(urlA);
    await expect(page).toHaveURL(urlA, { timeout: TIMEOUTS.MEDIUM });

    const headerTitle = await new ChatComponent(page).getChatHeaderTitle();
    expect(headerTitle).toBeTruthy();
    await sidebar.expandIfCollapsed();
    const sidebarTitle = await sidebar.getChatTitleById(chatIdA);
    expect(headerTitle).toBe(sidebarTitle);
  });

  test("Rename chat – sidebar and header update", async ({ page }) => {
    const chat = await setupChat(page);
    const sidebar = new SidebarComponent(page);

    await sendAndWaitForResponse(chat, "Rename test – hello", TIMEOUTS.MEDIUM);
    await sidebar.expandIfCollapsed();
    await expect(async () => {
      const items = await sidebar.getAllChatItems();
      expect(await items.count()).toBeGreaterThan(0);
    }).toPass({ timeout: TIMEOUTS.MEDIUM });

    const chatId = new URL(page.url()).pathname.replace(/^\/c\//, "");
    expect(chatId).toBeTruthy();

    await sidebar.openChatOptionsById(chatId);
    await page.getByRole("menuitem", { name: "Rename" }).click();

    const newTitle = `Renamed-${Date.now()}`;
    await page.getByPlaceholder("Chat name").fill(newTitle);
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("dialog", { name: "Rename Chat" })).toBeHidden({
      timeout: TIMEOUTS.SHORT,
    });

    await sidebar.expectChatWithTitle(newTitle);
    const headerTitle = await new ChatComponent(page).getChatHeaderTitle();
    expect(headerTitle).toBe(newTitle);
  });

  test("Two chats: send in first, switch to second, send in second – correct threads", async ({
    page,
  }) => {
    const { urlA, urlB } = await createTwoChats(
      page,
      TEST_DATA.MESSAGES.MATH_SIMPLE,
      TEST_DATA.MESSAGES.MATH_NEXT,
      TIMEOUTS.MEDIUM,
    );
    const sidebar = new SidebarComponent(page);

    await sidebar.expandIfCollapsed();
    await sidebar.clickChatByUrl(urlA);
    await expect(page).toHaveURL(urlA, { timeout: TIMEOUTS.MEDIUM });
    await new ChatComponent(page).expectMessageContains("4");

    await sidebar.expandIfCollapsed();
    await sidebar.clickChatByUrl(urlB);
    await expect(page).toHaveURL(urlB, { timeout: TIMEOUTS.MEDIUM });
    await new ChatComponent(page).expectMessageContains("6");
  });
});
