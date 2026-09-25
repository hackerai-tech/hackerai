import { emitPostHogLog, flushPostHogLogs } from "../logs";

describe("bounded diagnostic export", () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.POSTHOG_PROJECT_TOKEN;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    process.env.POSTHOG_PROJECT_TOKEN = "test-token";
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
  });
  afterEach(async () => {
    await flushPostHogLogs();
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
    else process.env.POSTHOG_PROJECT_TOKEN = originalToken;
  });
  const exportAttributes = async (attributes: Record<string, unknown>) => {
    expect(
      emitPostHogLog({
        level: "info",
        event: "upload_finished",
        body: "Complete",
        attributes,
      }),
    ).toBe(true);
    await flushPostHogLogs();
    return JSON.parse(fetchMock.mock.calls[0][1].body).resourceLogs[0]
      .scopeLogs[0].logRecords[0].attributes as Array<{
      key: string;
      value: Record<string, unknown>;
    }>;
  };

  it("preserves primitive values and correlation identifiers under attribute pressure", async () => {
    const attributes: Record<string, unknown> = {
      attempts: 2,
      recovered: true,
    };
    for (let i = 0; i < 500; i++) attributes[`field${i}`] = "value";
    attributes.sessionId = "session-123";
    attributes.posthogDistinctId = "user-123";
    const result = await exportAttributes(attributes);
    expect(result).toHaveLength(80);
    expect(result).toEqual(
      expect.arrayContaining([
        { key: "sessionId", value: { stringValue: "session-123" } },
        { key: "posthogDistinctId", value: { stringValue: "user-123" } },
        { key: "attempts", value: { doubleValue: 2 } },
        { key: "recovered", value: { boolValue: true } },
      ]),
    );
  });

  it("does not access excess attributes, getters, or custom serialization", async () => {
    const getter = jest.fn(() => {
      throw new Error("must not run");
    });
    const toJSON = jest.fn(() => {
      throw new Error("must not run");
    });
    const value = { toJSON, safe: "ok" };
    Object.defineProperty(value, "expensive", {
      enumerable: true,
      get: getter,
    });
    const attributes: Record<string, unknown> = { value };
    Object.defineProperty(attributes, "unsafe", {
      enumerable: true,
      get: getter,
    });
    for (let i = 0; i < 100; i++) attributes[`field${i}`] = "ok";
    attributes.excess = { toJSON };
    const result = await exportAttributes(attributes);
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(result.some(({ key }) => key === "excess")).toBe(false);
    expect(
      result.find(({ key }) => key === "value")?.value.stringValue,
    ).toContain('"safe":"ok"');
  });

  it("bounds wide, deep, cyclic and long values before encoding", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no access");
        },
      },
    );
    const result = await exportAttributes({
      long: ["x".repeat(2_000_000)],
      wide: Array.from({ length: 100_000 }, () => ({ value: "x" })),
      deep: { a: { b: { c: { d: { e: "hidden" } } } } },
      circular,
      throwing,
      big: 1n,
      ["a".repeat(1_000_000)]: "bounded key",
    });
    for (const { key, value } of result) {
      expect(key.length).toBeLessThanOrEqual(128);
      if (typeof value.stringValue === "string")
        expect(value.stringValue.length).toBeLessThanOrEqual(2003);
    }
    expect(
      result.find(({ key }) => key === "deep")?.value.stringValue,
    ).toContain("depth limit");
    expect(
      result.find(({ key }) => key === "circular")?.value.stringValue,
    ).toContain("circular");
    expect(
      result.find(({ key }) => key === "throwing")?.value.stringValue,
    ).toContain("unavailable");
  });
});
