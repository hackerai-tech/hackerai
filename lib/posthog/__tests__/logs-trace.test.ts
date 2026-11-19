import { AsyncLocalStorage } from "node:async_hooks";
import { context, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import type { Context, ContextManager, Span } from "@opentelemetry/api";
import { emitPostHogLog, flushPostHogLogs } from "../logs";

// Control the upstream context producer through the real API. AsyncLocalStorage
// keeps concurrent contexts separate; the exporter and payload are not mocked.
const storage = new AsyncLocalStorage<Context>();
const manager: ContextManager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with(ctx, fn, thisArg, ...args) {
    return storage.run(ctx, () => fn.call(thisArg, ...args));
  },
  bind: (_ctx, target) => target,
  enable() {
    return this;
  },
  disable() {
    storage.disable();
    return this;
  },
};
const activeContext = (traceId: string, spanId: string) =>
  trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
  });
const first = { traceId: "a".repeat(32), spanId: "1".repeat(16) };
const second = { traceId: "b".repeat(32), spanId: "2".repeat(16) };
const flush = { traceId: "c".repeat(32), spanId: "3".repeat(16) };
const emit = (event: string) =>
  emitPostHogLog({ level: "info", event, body: "Synthetic trace QA" });

describe("queued log trace correlation", () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.POSTHOG_PROJECT_TOKEN;
  let fetchMock: jest.Mock;

  beforeAll(() => {
    expect(context.setGlobalContextManager(manager)).toBe(true);
  });
  beforeEach(() => {
    process.env.POSTHOG_PROJECT_TOKEN = "synthetic-test-token";
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
  });
  afterEach(async () => {
    await flushPostHogLogs();
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
    else process.env.POSTHOG_PROJECT_TOKEN = originalToken;
  });
  afterAll(() => {
    context.disable();
  });
  const records = () =>
    JSON.parse(fetchMock.mock.calls[0][1].body).resourceLogs[0].scopeLogs[0]
      .logRecords;

  it("retains each concurrent caller's IDs when flushing under another span", async () => {
    await Promise.all(
      [first, second].map((ids, index) =>
        context.with(activeContext(ids.traceId, ids.spanId), async () => {
          await Promise.resolve();
          expect(emit(`synthetic_${index}`)).toBe(true);
        }),
      ),
    );
    await context.with(activeContext(flush.traceId, flush.spanId), () =>
      flushPostHogLogs(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(2);
    expect(records()).toEqual([
      expect.objectContaining(first),
      expect.objectContaining(second),
    ]);
  });

  it("does not borrow the flush span for a caller with no active span", async () => {
    expect(emit("no_active_span")).toBe(true);
    await context.with(activeContext(flush.traceId, flush.spanId), () =>
      flushPostHogLogs(),
    );
    expect(records()[0]).not.toHaveProperty("traceId");
    expect(records()[0]).not.toHaveProperty("spanId");
    expect(records()[0].body.stringValue).toBe("Synthetic trace QA");
  });

  it.each([
    ["0".repeat(32), first.spanId],
    [first.traceId, "0".repeat(16)],
    ["private text", first.spanId],
    [first.traceId, "x".repeat(16)],
    [`${first.traceId}\n`, first.spanId],
    [first.traceId, `${first.spanId}\n`],
  ])("omits an invalid context pair (%s, %s)", async (traceId, spanId) => {
    expect(
      context.with(activeContext(traceId, spanId), () => emit("invalid_span")),
    ).toBe(true);
    await flushPostHogLogs();
    expect(records()[0]).not.toHaveProperty("traceId");
    expect(records()[0]).not.toHaveProperty("spanId");
  });

  it("normalizes valid uppercase IDs without retaining the span object", async () => {
    const span = trace.wrapSpanContext({
      traceId: "A".repeat(32),
      spanId: "B".repeat(16),
      traceFlags: TraceFlags.SAMPLED,
    });
    Object.assign(span, { privateAttribute: "must not be serialized" });
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => emit("uppercase"));
    await flushPostHogLogs();
    expect(records()[0]).toEqual(
      expect.objectContaining({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
      }),
    );
    expect(JSON.stringify(records())).not.toContain("privateAttribute");
    expect(JSON.stringify(records())).not.toContain("must not be serialized");
  });

  it("still exports the original log when the span provider throws", async () => {
    const span = {
      spanContext: () => {
        throw new Error("unavailable context");
      },
    } as unknown as Span;
    expect(
      context.with(trace.setSpan(ROOT_CONTEXT, span), () =>
        emit("throwing_span"),
      ),
    ).toBe(true);
    await flushPostHogLogs();
    expect(records()).toHaveLength(1);
    expect(records()[0]).not.toHaveProperty("traceId");
    expect(records()[0].body.stringValue).toBe("Synthetic trace QA");
  });

  it("snapshots primitives without retaining mutable or private span context", async () => {
    const serialize = jest.fn(() => "private span contents");
    const source = {
      ...first,
      traceFlags: TraceFlags.SAMPLED,
      privateValue: "private span contents",
      toJSON: serialize,
    };
    context.with(
      trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(source)),
      () => emit("mutable_span"),
    );
    source.traceId = second.traceId;
    source.spanId = second.spanId;
    await flushPostHogLogs();
    expect(records()[0]).toEqual(expect.objectContaining(first));
    expect(serialize).not.toHaveBeenCalled();
    expect(JSON.stringify(records())).not.toContain("private span contents");
    expect(records()[0]).not.toHaveProperty("traceFlags");
  });

  it("does not coerce a malformed identifier object", async () => {
    const coerce = jest.fn(() => first.traceId);
    const span = {
      spanContext: () => ({
        traceId: { toString: coerce },
        spanId: first.spanId,
      }),
    } as unknown as Span;
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => emit("object_id"));
    await flushPostHogLogs();
    expect(coerce).not.toHaveBeenCalled();
    expect(records()[0]).not.toHaveProperty("traceId");
    expect(records()[0]).not.toHaveProperty("spanId");
  });
});
