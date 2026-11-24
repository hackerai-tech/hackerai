import type { UIMessage } from "ai";
import { createAgentSteerInbox } from "@/lib/chat/agent-steer";
import { convertToModelMessagesWithSteers } from "@/lib/chat/agent-steer-model-messages";

describe("agent steer history", () => {
  it("replays a steer as the user's message between the outputs it separated", async () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Scan it" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Scanning production." },
          {
            type: "data-agent-steer",
            id: "s1",
            data: { id: "s1", text: "Use staging" },
          },
          { type: "step-start" },
          { type: "text", text: "Switching to staging." },
        ],
      },
    ];

    const model = await convertToModelMessagesWithSteers(messages);

    expect(model.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(model[2].content).toEqual([{ type: "text", text: "Use staging" }]);
    expect(JSON.stringify(model[3].content)).toContain("Switching to staging.");
  });
});

describe("createAgentSteerInbox", () => {
  it("reads each steer once though the store returns every claimed steer", async () => {
    const first = { id: "a", text: "first" };
    const second = { id: "b", text: "second" };
    const claim = jest
      .fn<Promise<Array<{ id: string; text: string }>>, []>()
      .mockRejectedValueOnce(new Error("timeout after commit"))
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, second]);
    const inbox = createAgentSteerInbox({ claim });

    expect(await inbox.claim()).toEqual([]);
    expect(await inbox.claim()).toEqual([first]);
    expect(await inbox.claim()).toEqual([second]);
    expect(inbox.delivered()).toEqual([first, second]);
  });

  it("continues the step without new steers when the store is unavailable", async () => {
    const onError = jest.fn(() => {
      throw new Error("reporting failed too");
    });
    const inbox = createAgentSteerInbox({
      claim: () => Promise.reject(new Error("convex down")),
      onError,
    });

    await expect(inbox.claim()).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(inbox.delivered()).toEqual([]);
  });
});
