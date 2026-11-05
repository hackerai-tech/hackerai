import type { ChatMessage } from "@/types";
import { getLatestAgentLongAssistantMessageForPartialSave as snapshot } from "../agent-partial-save-snapshot";
import { createAgentPartialSaveQueue } from "../agent-partial-save-queue";

const assistant = (id: string): ChatMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: "Partial progress" }],
});

it("does not enqueue an old response under a newly correlated run", async () => {
  const queue = createAgentPartialSaveQueue();
  const write = jest.fn(async () => ({ ok: true, status: 200 }));
  const old = assistant("run_previous");
  const stale = snapshot([old], "run_current");
  if (stale) await queue.save("chat", stale.id, write);
  expect(stale).toBeUndefined();
  expect(await queue.flush("chat")).toBe(false);
  expect(write).not.toHaveBeenCalled();

  // When this run's response arrives, it is still eligible for persistence.
  const current = snapshot([old, assistant("run_current")], "run_current");
  expect(current?.id).toBe("run_current");
  await queue.save("chat", current!.id, write);
  await queue.flush("chat");
  expect(write).toHaveBeenCalledTimes(1);
});

it("does not search backwards into an earlier turn or another run", () => {
  const current = assistant("run_current");
  expect(
    snapshot([current, assistant("run_other")], "run_current"),
  ).toBeUndefined();
  expect(
    snapshot(
      [current, { id: "user-next", role: "user", parts: [] }],
      "run_current",
    ),
  ).toBeUndefined();
  expect(snapshot([], "run_current")).toBeUndefined();
});

it("preserves current-run progress and timing while excluding heartbeat-only saves", () => {
  const message = {
    ...assistant("run_current"),
    metadata: { generationStartedAt: 100, generationTimeMs: 200 },
    parts: [
      { type: "data-agent-heartbeat", data: { timestamp: 300 } },
      { type: "text", text: "Partial progress" },
    ],
  } as ChatMessage;
  expect(snapshot([message], "run_current")).toEqual({
    id: "run_current",
    role: "assistant",
    parts: [{ type: "text", text: "Partial progress" }],
    generationStartedAt: 100,
    generationTimeMs: 200,
  });
  expect(message.parts).toHaveLength(2);
  expect(
    snapshot([{ ...message, parts: [message.parts[0]] }], "run_current"),
  ).toBeUndefined();
});
