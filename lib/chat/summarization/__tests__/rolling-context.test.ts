import type { ModelMessage, UIMessage } from "ai";
import {
  buildCompactedRollingBase,
  buildRollingModelMessages,
  isRollingCompactionEffective,
  RollingCompactionAttempts,
  type RollingModelContextCheckpoint,
} from "../rolling-context";

jest.mock("@/lib/db/actions", () => ({}));

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});
const toolPair = (id: string, output: string): ModelMessage[] => [
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: id, toolName: "lookup", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "lookup",
        output: { type: "text", value: output },
      },
    ],
  },
];
const summary = (text: string) => ({
  summaryMessage: {
    id: "summary",
    role: "user",
    parts: [
      {
        type: "text",
        text: `<context_summary>\n${text}\n</context_summary>`,
      },
    ],
  } as UIMessage,
  userMessageContextTokens: 0,
  runtimeContextTokens: 0,
});

describe("rolling agent model context", () => {
  it("keeps the first compacted base and appends only newer SDK messages", () => {
    const initial = user("original history");
    const firstStep = assistant("first tool step");
    const secondStep = assistant("second tool step");
    const summaryMessage = user("summary 1");
    const continuation = user("continue");
    const rawMessages = [initial, firstStep, secondStep];
    const checkpoint: RollingModelContextCheckpoint = {
      baseMessages: [summaryMessage, continuation],
      rawMessageCursor: 2,
    };

    expect(buildRollingModelMessages(rawMessages, checkpoint)).toEqual([
      summaryMessage,
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

describe("RollingCompactionAttempts", () => {
  const threshold = 256_000;

  it("stops after two compactions whose next request stays over the threshold", () => {
    const attempts = new RollingCompactionAttempts();
    attempts.record(10);
    attempts.confirm(270_000, threshold);
    expect(attempts.canCompact()).toBe(true);
    attempts.record(12);
    attempts.confirm(260_000, threshold);

    expect(attempts.canCompact()).toBe(false);
    expect(attempts.attemptCount).toBe(2);
    expect(attempts.lastRawMessageCount).toBe(12);
  });

  it("resets the bound once the provider measures a recovered prompt", () => {
    const attempts = new RollingCompactionAttempts();
    attempts.record();
    attempts.confirm(270_000, threshold);
    attempts.record();
    attempts.confirm(120_000, threshold);

    expect(attempts.canCompact()).toBe(true);
    expect(attempts.unproductiveCount).toBe(0);
  });

  it("requires estimated headroom when the provider omits usage", () => {
    const attempts = new RollingCompactionAttempts();
    attempts.record();
    attempts.pendingInputEstimate = threshold * 0.85;
    attempts.confirm(undefined, threshold);
    expect(attempts.unproductiveCount).toBe(1);

    attempts.record();
    attempts.pendingInputEstimate = threshold * 0.5;
    attempts.confirm(undefined, threshold);
    expect(attempts.unproductiveCount).toBe(0);
  });
});

describe("buildCompactedRollingBase", () => {
  it("keeps pinned instructions verbatim and a complete recent tool pair after the summary", async () => {
    const objective = user("Objective: validate only staging.example.test");
    const update = user("Parent update: also check /admin");
    const [oldCall, oldResult] = toolPair("old", "old output ".repeat(10_000));
    const [recentCall, recentResult] = toolPair("recent", "recent output");
    const source = [
      objective,
      oldCall,
      oldResult,
      update,
      recentCall,
      recentResult,
    ];
    const continuation = user("continue");

    const result = await buildCompactedRollingBase({
      compaction: summary("Checked the login form."),
      sourceMessages: source,
      tools: {},
      pinnedMessages: [objective, update],
      trailingMessages: [continuation],
    });

    expect(result.effective).toBe(true);
    expect(result.summaryMessageCount).toBe(1);
    expect(result.baseMessages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(result.baseMessages[0])).toContain(
      "Checked the login form.",
    );
    // Pinned objects are reused, not re-quoted or duplicated in the tail.
    expect(result.baseMessages.slice(1, 3)).toEqual([objective, update]);
    expect(result.baseMessages.filter((m) => m === objective)).toHaveLength(1);
    expect(result.retainedTail.slice(-2)).toEqual([recentCall, recentResult]);
    expect(result.retainedTail).not.toContainEqual(update);
    expect(result.baseMessages.filter((m) => m === update)).toHaveLength(1);
    expect(result.baseMessages.at(-1)).toBe(continuation);
    // Older outputs are at most a bounded preview, never the raw source.
    expect(JSON.stringify(result.baseMessages).length).toBeLessThan(
      JSON.stringify(source).length / 2,
    );
  });

  it("reports an ineffective compaction when pinned content dominates", async () => {
    const objective = user("scope ".repeat(5_000));
    const result = await buildCompactedRollingBase({
      compaction: summary("Short summary."),
      sourceMessages: [objective, assistant("brief reply")],
      tools: {},
      pinnedMessages: [objective],
      trailingMessages: [user("continue")],
    });

    expect(result.effective).toBe(false);
  });
});
