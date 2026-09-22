import { ToolLoopObserver } from "../tool-loop-observer";

const tools = new Set([
  "file",
  "run_terminal_cmd",
  "open_url",
  "interact_terminal_session",
  "wait_for_agents",
]);
const observe = (
  observer: ToolLoopObserver,
  input: unknown = { path: "/private" },
  output: unknown = "unchanged",
  toolName = "file",
) =>
  observer.observe(
    [{ toolCallId: "call", toolName, input }],
    [{ toolCallId: "call", output }],
    tools,
  );

describe("ToolLoopObserver", () => {
  it("reports identical results at three and five laps without retaining content", () => {
    const observer = new ToolLoopObserver();
    const events = Array.from({ length: 10 }, () => observe(observer));
    expect(events.filter(Boolean)).toEqual([
      { toolNames: ["file"], repeatCount: 3, cycleLength: 1 },
      { toolNames: ["file"], repeatCount: 5, cycleLength: 1 },
    ]);
    expect(JSON.stringify(observer)).not.toContain("/private");
    expect(JSON.stringify(observer)).not.toContain("unchanged");
  });

  it.each([2, 3, 4])("detects repeating %i-step cycles", (period) => {
    const observer = new ToolLoopObserver();
    let result;
    for (let i = 0; i < period * 3; i++) {
      result = observe(
        observer,
        { path: `/${i % period}` },
        `result ${i % period}`,
      );
    }
    expect(result).toEqual({
      toolNames: ["file"],
      repeatCount: 3,
      cycleLength: period,
    });
  });

  it("does not confuse changed output with stalled work", () => {
    const observer = new ToolLoopObserver();
    for (let i = 0; i < 20; i++)
      expect(observe(observer, {}, `new result ${i}`)).toBeUndefined();
  });

  it("preserves normal edit/test cycles with changing edits", () => {
    const observer = new ToolLoopObserver();
    for (let i = 0; i < 10; i++) {
      expect(
        observe(
          observer,
          { action: "edit", content: `revision ${i}` },
          "saved",
        ),
      ).toBeUndefined();
      expect(
        observe(
          observer,
          { command: "test" },
          "test failed",
          "run_terminal_cmd",
        ),
      ).toBeUndefined();
    }
  });

  it.each(["interact_terminal_session", "wait_for_agents"])(
    "exempts %s polling and does not join history across polls",
    (tool) => {
      const observer = new ToolLoopObserver();
      for (let i = 0; i < 10; i++) {
        expect(observe(observer)).toBeUndefined();
        expect(observe(observer, {}, "running", tool)).toBeUndefined();
      }
    },
  );

  it("matches results by call ID and canonicalizes object keys and batch order", () => {
    const observer = new ToolLoopObserver();
    const a = {
      toolCallId: "a",
      toolName: "file",
      input: { path: "/a", action: "read", brief: "first" },
    };
    const b = { toolCallId: "b", toolName: "file", input: { path: "/b" } };
    const results = [
      { toolCallId: "b", output: "b" },
      { toolCallId: "a", output: "a" },
    ];
    observer.observe([a, b], results, tools);
    observer.observe(
      [b, { ...a, input: { brief: "second", action: "read", path: "/a" } }],
      results,
      tools,
    );
    expect(observer.observe([a, b], results, tools)?.repeatCount).toBe(3);
  });

  it("breaks history when a result is missing or a name is not a registered tool", () => {
    const observer = new ToolLoopObserver();
    observe(observer);
    observe(observer);
    expect(
      observer.observe(
        [{ toolCallId: "call", toolName: "file", input: {} }],
        [],
        tools,
      ),
    ).toBeUndefined();
    expect(observe(observer)).toBeUndefined();
    expect(
      observe(observer, {}, "result", "private-model-invented-name"),
    ).toBeUndefined();
    expect(JSON.stringify(observer)).not.toContain(
      "private-model-invented-name",
    );
    expect(observe(observer)).toBeUndefined();
  });

  it("skips oversized, cyclic, and non-JSON results without throwing", () => {
    const observer = new ToolLoopObserver();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const result of [
      "x".repeat(70_000),
      cyclic,
      new Error("private error"),
      undefined,
      BigInt(1),
    ]) {
      expect(observe(observer, {}, result)).toBeUndefined();
    }
  });

  it("keeps arrays distinct from object entries", () => {
    const observer = new ToolLoopObserver();
    observe(observer, {}, { a: 1 });
    observe(observer, {}, [["a", 1]]);
    expect(observe(observer, {}, { a: 1 })).toBeUndefined();
  });

  it("caps telemetry and retained history over long runs", () => {
    const observer = new ToolLoopObserver();
    for (let i = 0; i < 1_000; i++) observe(observer, { i }, "output");
    expect(JSON.stringify(observer).length).toBeLessThan(4_000);
    expect(observer.shouldReport("loop", "observe", 3)).toBe(true);
    expect(observer.shouldReport("loop", "observe", 3)).toBe(false);
    for (let i = 0; i < 15; i++)
      expect(observer.shouldReport(`reason-${i}`, "halt", 1)).toBe(true);
    expect(observer.shouldReport("last", "halt", 1)).toBe(false);
  });
});
