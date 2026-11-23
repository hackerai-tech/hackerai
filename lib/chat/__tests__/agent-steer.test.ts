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
  it("confirms each received steer on the next claim and at the end", async () => {
    const claim = jest
      .fn<Promise<Array<{ id: string; text: string }>>, [string[]]>()
      .mockResolvedValueOnce([{ id: "a", text: "first" }])
      .mockResolvedValueOnce([{ id: "b", text: "second" }]);
    const acknowledge = jest.fn<Promise<void>, [string[]]>(async () => {});
    const inbox = createAgentSteerInbox({ claim, acknowledge });

    expect(await inbox.claim()).toEqual([{ id: "a", text: "first" }]);
    expect(await inbox.claim()).toEqual([{ id: "b", text: "second" }]);
    await inbox.acknowledge();
    await inbox.acknowledge();

    expect(claim.mock.calls).toEqual([[[]], [["a"]]]);
    expect(acknowledge.mock.calls).toEqual([[["b"]]]);
    expect(inbox.delivered().map((steer) => steer.id)).toEqual(["a", "b"]);
  });

  it("reads a steer once when a lost response makes the store return it again", async () => {
    const steer = { id: "a", text: "first" };
    const claim = jest
      .fn<Promise<Array<{ id: string; text: string }>>, [string[]]>()
      .mockRejectedValueOnce(new Error("timeout after commit"))
      .mockResolvedValueOnce([steer])
      .mockResolvedValueOnce([steer]);
    const inbox = createAgentSteerInbox({
      claim,
      acknowledge: async () => {},
    });

    expect(await inbox.claim()).toEqual([]);
    expect(await inbox.claim()).toEqual([steer]);
    expect(await inbox.claim()).toEqual([]);
    expect(inbox.delivered()).toEqual([steer]);
  });

  it("continues the step without new steers when the store is unavailable", async () => {
    const onError = jest.fn(() => {
      throw new Error("reporting failed too");
    });
    const inbox = createAgentSteerInbox({
      claim: () => Promise.reject(new Error("convex down")),
      acknowledge: async () => {},
      onError,
    });

    await expect(inbox.claim()).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(inbox.delivered()).toEqual([]);
  });
});
