const addTagsMock = jest.fn();
const warnMock = jest.fn();

jest.mock("@trigger.dev/sdk", () => ({
  tags: { add: (...args: unknown[]) => addTagsMock(...args) },
  logger: { warn: (...args: unknown[]) => warnMock(...args) },
}));

import {
  addAgentLongTags,
  getMissingAgentLongTags,
} from "../agent-long-tag-updates";

const context = {
  runId: "run_opaque",
  chatId: "chat_opaque",
  userId: "user_opaque",
  stage: "task_start_missing" as const,
};

describe("addAgentLongTags", () => {
  beforeEach(() => {
    addTagsMock.mockReset();
    warnMock.mockReset();
  });

  it("writes tags normally", async () => {
    addTagsMock.mockResolvedValue(undefined);

    await expect(
      addAgentLongTags(["user_opaque", "chat_opaque"], context),
    ).resolves.toBe(true);

    expect(addTagsMock).toHaveBeenCalledWith(["user_opaque", "chat_opaque"]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("keeps Agent work alive when Trigger rate-limits a tag update", async () => {
    addTagsMock.mockRejectedValue(
      Object.assign(new Error("Rate limit exceeded"), {
        name: "TriggerApiError",
        status: 429,
        code: "rate_limit_exceeded",
      }),
    );

    await expect(
      addAgentLongTags(["user_opaque", "chat_opaque"], context),
    ).resolves.toBe(false);

    expect(warnMock).toHaveBeenCalledWith(
      "[agent-long] tag update rate limited",
      {
        event: "agent_long_tag_update_rate_limited",
        service: "agent-long",
        reason: "trigger_api_rate_limited",
        statusCode: 429,
        stage: "task_start_missing",
        runId: "run_opaque",
        chatId: "chat_opaque",
        userId: "user_opaque",
        errorCode: "rate_limit_exceeded",
      },
    );
  });

  it("rethrows unknown tag failures", async () => {
    const error = Object.assign(new Error("Trigger unavailable"), {
      name: "TriggerApiError",
      status: 503,
    });
    addTagsMock.mockRejectedValue(error);

    await expect(addAgentLongTags("terminal_error", context)).rejects.toBe(
      error,
    );
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("does not suppress unrelated 429-shaped application errors", async () => {
    const error = Object.assign(new Error("Application rate limited"), {
      status: 429,
    });
    addTagsMock.mockRejectedValue(error);

    await expect(addAgentLongTags("terminal_error", context)).rejects.toBe(
      error,
    );
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe("getMissingAgentLongTags", () => {
  it("avoids redundant task-start writes when run creation set every tag", () => {
    expect(
      getMissingAgentLongTags(
        ["user_opaque", "chat_opaque", "sub_pro"],
        ["user_opaque", "chat_opaque", "sub_pro"],
      ),
    ).toEqual([]);
  });

  it("preserves one combined write for direct or admin-triggered runs", () => {
    expect(
      getMissingAgentLongTags(
        ["user_opaque"],
        ["user_opaque", "chat_opaque", "sub_pro"],
      ),
    ).toEqual(["chat_opaque", "sub_pro"]);
  });
});
