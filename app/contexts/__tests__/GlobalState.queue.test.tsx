import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "@jest/globals";
import { GlobalStateProvider, useGlobalState } from "../GlobalState";

describe("message queue admission", () => {
  it("rejects the eleventh batched submission and admits again after removal or clearing", async () => {
    const { result } = renderHook(() => useGlobalState(), {
      wrapper: GlobalStateProvider,
    });
    const enqueue = result.current.queueMessage;
    let ids: (string | undefined)[] = [];
    await act(async () => {
      ids = Array.from({ length: 11 }, (_, index) =>
        enqueue(`Message ${index}`),
      );
    });
    expect(ids[10]).toBeUndefined();
    expect(result.current.messageQueue.map((message) => message.id)).toEqual(
      ids.slice(0, 10),
    );

    let replacement: string | undefined;
    await act(async () => {
      result.current.removeQueuedMessage(ids[0]!);
      result.current.setQueuedMessageDelivery(ids[1]!, "failed", 123);
      result.current.updateQueuedMessage(ids[2]!, "Edited before retry");
      replacement = enqueue("Replacement");
      expect(enqueue("Still full")).toBeUndefined();
    });
    expect(replacement).toBeDefined();
    expect(result.current.messageQueue).toHaveLength(10);
    expect(result.current.messageQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ids[1], deliveryStatus: "failed" }),
        expect.objectContaining({ id: ids[2], text: "Edited before retry" }),
        expect.objectContaining({ id: replacement, text: "Replacement" }),
      ]),
    );

    await act(async () => {
      result.current.clearQueue();
      expect(enqueue("After clear")).toBeDefined();
    });
    expect(result.current.messageQueue.map((message) => message.text)).toEqual([
      "After clear",
    ]);
  });
  it("isolates chat queues and applies delayed mutations to their original chat", async () => {
    const { result } = renderHook(() => useGlobalState(), {
      wrapper: GlobalStateProvider,
    });
    await act(async () => result.current.selectMessageQueue("a"));
    let first: string | undefined;
    await act(async () => {
      first = result.current.queueMessage("A");
    });
    const finishA = result.current.removeQueuedMessage;
    const enqueueA = result.current.queueMessage;
    await act(async () => result.current.selectMessageQueue("b"));
    expect(result.current.messageQueue).toEqual([]);
    await act(async () => {
      result.current.queueMessage("B");
      finishA(first!);
      enqueueA("A later");
    });
    expect(result.current.messageQueue.map((m) => m.text)).toEqual(["B"]);
    await act(async () => result.current.selectMessageQueue("a"));
    expect(result.current.messageQueue.map((m) => m.text)).toEqual(["A later"]);
  });

  it("never exposes another account's queue", async () => {
    const auth = require("@workos-inc/authkit-nextjs/components").useAuth;
    const original = auth();
    const originalFetch = global.fetch;
    global.fetch = jest.fn(
      async () => ({ ok: true, json: async () => ({}) }) as Response,
    );
    const { result, rerender } = renderHook(() => useGlobalState(), {
      wrapper: GlobalStateProvider,
    });
    try {
      await act(async () => result.current.selectMessageQueue("same-chat"));
      await act(async () => {
        result.current.queueMessage("Private draft");
      });
      auth.mockReturnValue({
        ...original,
        user: { ...original.user, id: "other-account" },
      });
      rerender();
      expect(result.current.messageQueue).toEqual([]);
      auth.mockReturnValue(original);
      rerender();
      expect(result.current.messageQueue.map((m) => m.text)).toEqual([
        "Private draft",
      ]);
    } finally {
      auth.mockReturnValue(original);
      global.fetch = originalFetch;
    }
  });
});
