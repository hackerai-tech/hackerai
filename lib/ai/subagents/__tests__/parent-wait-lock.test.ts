import { describe, expect, it, jest } from "@jest/globals";

import { serializeSubagentWaitForParent } from "../parent-wait-lock";

describe("serializeSubagentWaitForParent", () => {
  it("runs only one child wait at a time for the same parent", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializeSubagentWaitForParent("parent-1", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      return "first";
    });
    const secondWait = jest.fn(async () => {
      order.push("second:start");
      return "second";
    });
    const second = serializeSubagentWaitForParent("parent-1", secondWait);

    await Promise.resolve();
    expect(secondWait).not.toHaveBeenCalled();

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("releases the next wait when the previous wait rejects", async () => {
    const first = serializeSubagentWaitForParent("parent-2", async () => {
      throw new Error("failed");
    });
    const second = serializeSubagentWaitForParent(
      "parent-2",
      async () => "continued",
    );

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("continued");
  });

  it("runs waits for different parents concurrently", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = serializeSubagentWaitForParent("parent-3", async () => {
      await firstGate;
      return "first";
    });
    const second = serializeSubagentWaitForParent(
      "parent-4",
      async () => "second",
    );

    await expect(second).resolves.toBe("second");
    releaseFirst();
    await expect(first).resolves.toBe("first");
  });
});
