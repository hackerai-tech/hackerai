import { readFileSync } from "fs";
import { join } from "path";

import { isUserDeletionFenced } from "../lib/userDeletionFence";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("user deletion fence", () => {
  it.each([
    [null, false],
    [{ _id: "fence-1", user_id: "user-1", started_at: 1 }, true],
  ] as const)("maps a persisted fence to %s", async (row, expected) => {
    const first = jest.fn(async () => row);
    const withIndex = jest.fn(
      (_index: string, callback: (q: { eq: jest.Mock }) => void) => {
        const q = { eq: jest.fn(() => q) };
        callback(q);
        return { first };
      },
    );
    const db = {
      query: jest.fn(() => ({ withIndex })),
    };

    await expect(isUserDeletionFenced(db as never, "user-1")).resolves.toBe(
      expected,
    );
    expect(withIndex).toHaveBeenCalledWith("by_user_id", expect.any(Function));
  });

  it("guards every resource-creation boundary used during account deletion", () => {
    const accountRoute = read("app/api/delete-account/route.ts");
    const chats = read("convex/chats.ts");
    const subagents = read("convex/subagents.ts");

    expect(
      accountRoute.indexOf('stage = "begin_user_data_deletion"'),
    ).toBeLessThan(
      accountRoute.indexOf('stage = "fence_active_agent_resources"'),
    );
    expect(chats).toMatch(
      /saveChat = mutation[\s\S]*?isUserDeletionFenced\(ctx\.db, args\.userId\)/,
    );
    expect(chats).toMatch(
      /setActiveTriggerRun = mutation[\s\S]*?isUserDeletionFenced\(ctx\.db, chat\.user_id\)/,
    );
    expect(subagents).toMatch(
      /reserveForBackend = mutation[\s\S]*?isUserDeletionFenced\(ctx\.db, args\.userId\)/,
    );
    expect(subagents).toMatch(
      /resumeForBackend = mutation[\s\S]*?isUserDeletionFenced\(ctx\.db, args\.userId\)/,
    );
  });
});
