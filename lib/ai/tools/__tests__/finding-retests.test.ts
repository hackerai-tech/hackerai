/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const enabled = jest.fn<any>();
const state = jest.fn<any>();
const save = jest.fn<any>();
jest.mock("@/lib/findings/http-retest-policy", () => ({
  isHttpFindingRetestsEnabled: (...args: unknown[]) => enabled(...args),
}));
jest.mock("@/lib/findings/http-retest-service", () => ({
  getHttpRetestState: (...args: unknown[]) => state(...args),
  saveHttpRetestRecipe: (...args: unknown[]) => save(...args),
  runHttpRetest: () => {
    throw new Error("Agent tools must never run retests");
  },
}));

// Import after the mocks are registered; @jest/globals mocks are not hoisted
// above static imports.
const tools = () => import("../finding-retests");
const createGetHttpRetestRecipe = async (context: any) =>
  (await tools()).createGetHttpRetestRecipe(context);
const createSaveHttpRetestRecipe = async (context: any) =>
  (await tools()).createSaveHttpRetestRecipe(context);

const context = { userID: "user-1", chatId: "chat-1" } as any;
const options = { toolCallId: "t", messages: [] } as any;

describe("Agent HTTP retest recipe tools", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fail closed when the rollout is off", async () => {
    enabled.mockResolvedValue(false);
    const result = await (
      await createSaveHttpRetestRecipe(context)
    ).execute!(
      { finding_id: "finding-1", expected_version: 0, recipe: {} as any },
      options,
    );
    expect(result).toMatchObject({ success: false, error: "unavailable" });
    expect(save).not.toHaveBeenCalled();
  });

  it("saves as an agent version scoped to the current chat", async () => {
    enabled.mockResolvedValue(true);
    save.mockResolvedValue({ success: true, version: 2 });
    const recipe = { title: "r" } as any;
    const result = await (
      await createSaveHttpRetestRecipe(context)
    ).execute!(
      { finding_id: "finding-1", expected_version: 1, recipe },
      options,
    );
    expect(save).toHaveBeenCalledWith({
      userId: "user-1",
      findingId: "finding-1",
      chatId: "chat-1",
      expectedVersion: 1,
      recipe,
      source: "agent",
    });
    expect(result).toMatchObject({ success: true, version: 2 });
  });

  it("reads only reports from the current chat", async () => {
    enabled.mockResolvedValue(true);
    state.mockResolvedValue({ available: false });
    const result = await (
      await createGetHttpRetestRecipe(context)
    ).execute!({ finding_id: "finding-other" }, options);
    expect(state).toHaveBeenCalledWith({
      userId: "user-1",
      findingId: "finding-other",
      chatId: "chat-1",
    });
    expect(result).toMatchObject({ success: false, error: "not_found" });
  });
});
