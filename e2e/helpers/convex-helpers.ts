import * as dotenv from "dotenv";
import * as path from "path";
import { WorkOS } from "@workos-inc/node";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { getTestUsersRecord } from "../../scripts/test-users-config";

function loadEnv(): void {
  dotenv.config({ path: path.join(process.cwd(), ".env.e2e") });
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
}

function getConvexEnv(): { convexUrl: string; serviceKey: string } | null {
  loadEnv();
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!convexUrl || !serviceKey) return null;
  return { convexUrl, serviceKey };
}

/**
 * Get the WorkOS user ID for the pro test user.
 */
export async function getProUserId(): Promise<string | null> {
  loadEnv();
  const workosKey = process.env.WORKOS_API_KEY;
  const workosClientId = process.env.WORKOS_CLIENT_ID;
  if (!workosKey || !workosClientId) return null;
  try {
    const workos = new WorkOS(workosKey, { clientId: workosClientId });
    const proEmail = getTestUsersRecord().pro.email;
    const { data } = await workos.userManagement.listUsers({
      email: proEmail,
    });
    return data[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete all chats for the pro test user.
 * Used for test cleanup/teardown.
 */
export async function deleteTestUserChats(): Promise<void> {
  const env = getConvexEnv();
  if (!env) return;
  try {
    const userId = await getProUserId();
    if (!userId) return;
    const convex = new ConvexHttpClient(env.convexUrl);
    await convex.mutation(api.chats.deleteAllChatsForUser, {
      serviceKey: env.serviceKey,
      userId,
    });
  } catch {
    // Teardown is best-effort; do not fail the run
  }
}

/**
 * Create multiple chats for the pro test user via Convex API.
 * Use for tests that need more than one page of sidebar chats (e.g. pagination).
 */
export async function createManyTestChatsForProUser(
  count: number,
): Promise<void> {
  const env = getConvexEnv();
  if (!env) return;
  const userId = await getProUserId();
  if (!userId) return;
  const convex = new ConvexHttpClient(env.convexUrl);
  const { randomUUID } = await import("crypto");
  for (let i = 0; i < count; i++) {
    await convex.mutation(api.chats.saveChat, {
      serviceKey: env.serviceKey,
      id: randomUUID(),
      userId,
      title: `Pagination test chat ${i} ${Date.now()}`,
    });
  }
}
