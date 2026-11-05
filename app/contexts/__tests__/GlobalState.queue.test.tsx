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
});
