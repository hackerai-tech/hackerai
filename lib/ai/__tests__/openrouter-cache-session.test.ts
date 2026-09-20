import { createOpenRouterCacheSessionId } from "@/lib/ai/openrouter-cache-session";

describe("createOpenRouterCacheSessionId", () => {
  const input = {
    chatId: "chat-secret-123",
    mode: "agent",
    requestedModelSlug: "deepseek/deepseek-v4.1-flash",
  };

  it("is stable, opaque, and within OpenRouter's length limit", () => {
    const first = createOpenRouterCacheSessionId(input);
    const second = createOpenRouterCacheSessionId(input);

    expect(first).toBe(second);
    expect(first).toMatch(/^hackerai-cache-v1-[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(input.chatId);
    expect(first.length).toBeLessThanOrEqual(256);
  });

  it("changes when the chat, mode, or model route changes", () => {
    const baseline = createOpenRouterCacheSessionId(input);

    expect(
      createOpenRouterCacheSessionId({ ...input, chatId: "another-chat" }),
    ).not.toBe(baseline);
    expect(createOpenRouterCacheSessionId({ ...input, mode: "ask" })).not.toBe(
      baseline,
    );
    expect(
      createOpenRouterCacheSessionId({
        ...input,
        requestedModelSlug: "deepseek/deepseek-v4-flash-0731",
      }),
    ).not.toBe(baseline);
  });
});
