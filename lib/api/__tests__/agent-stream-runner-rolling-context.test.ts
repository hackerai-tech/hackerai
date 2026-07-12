import type { ModelMessage } from "ai";
import {
  buildRollingModelMessages,
  isRollingCompactionEffective,
  type RollingModelContextCheckpoint,
} from "@/lib/api/agent-stream-runner";

jest.mock("@/lib/db/actions", () => ({}));

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});

describe("rolling agent model context", () => {
  it("keeps the first compacted base and appends only newer SDK messages", () => {
    const initial = user("original history");
    const firstStep = assistant("first tool step");
    const secondStep = assistant("second tool step");
    const summary = user("summary 1");
    const continuation = user("continue");
    const rawMessages = [initial, firstStep, secondStep];
    const checkpoint: RollingModelContextCheckpoint = {
      baseMessages: [summary, continuation],
      rawMessageCursor: 2,
    };

    expect(buildRollingModelMessages(rawMessages, checkpoint)).toEqual([
      summary,
      continuation,
      secondStep,
    ]);
  });

  it("supports two compactions without restoring the original history", () => {
    const original = user("original history");
    const step1 = assistant("step 1");
    const step2 = assistant("step 2");
    const step3 = assistant("step 3");
    const summary1 = user("summary 1");
    const summary2 = user("summary 2");

    const rawAfterStep2 = [original, step1, step2];
    const firstCheckpoint: RollingModelContextCheckpoint = {
      baseMessages: [summary1],
      rawMessageCursor: 2,
    };
    expect(buildRollingModelMessages(rawAfterStep2, firstCheckpoint)).toEqual([
      summary1,
      step2,
    ]);

    const secondCheckpoint: RollingModelContextCheckpoint = {
      baseMessages: [summary2],
      rawMessageCursor: rawAfterStep2.length,
    };
    expect(
      buildRollingModelMessages([...rawAfterStep2, step3], secondCheckpoint),
    ).toEqual([summary2, step3]);
  });

  it("rejects compactions that do not reduce serialized context by 10 percent", () => {
    const previous = [user("x".repeat(1_000))];

    expect(isRollingCompactionEffective(previous, [user("summary")])).toBe(
      true,
    );
    expect(
      isRollingCompactionEffective(previous, [user("y".repeat(950))]),
    ).toBe(false);
  });
});
