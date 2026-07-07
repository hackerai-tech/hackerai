import { describe, expect, it } from "@jest/globals";
import { createReasoningSequenceGuard } from "../agent-long-reasoning-sequence-guard";

describe("createReasoningSequenceGuard", () => {
  it("keeps a valid reasoning start, delta, and end sequence", () => {
    const guard = createReasoningSequenceGuard();

    expect(guard.shouldDrop({ type: "reasoning-start", id: "r1" })).toBe(
      false,
    );
    expect(guard.shouldDrop({ type: "reasoning-delta", id: "r1" })).toBe(
      false,
    );
    expect(guard.shouldDrop({ type: "reasoning-end", id: "r1" })).toBe(false);
  });

  it("drops reasoning deltas and ends that have no matching start", () => {
    const guard = createReasoningSequenceGuard();

    expect(guard.shouldDrop({ type: "reasoning-delta", id: "missing" })).toBe(
      true,
    );
    expect(guard.shouldDrop({ type: "reasoning-end", id: "missing" })).toBe(
      true,
    );
  });

  it("drops duplicate reasoning ends after the active part was closed", () => {
    const guard = createReasoningSequenceGuard();

    guard.shouldDrop({ type: "reasoning-start", id: "r1" });
    expect(guard.shouldDrop({ type: "reasoning-end", id: "r1" })).toBe(false);
    expect(guard.shouldDrop({ type: "reasoning-end", id: "r1" })).toBe(true);
  });

  it("resets active reasoning parts at step and terminal boundaries", () => {
    const guard = createReasoningSequenceGuard();

    guard.shouldDrop({ type: "reasoning-start", id: "r1" });
    expect(guard.shouldDrop({ type: "finish-step" })).toBe(false);
    expect(guard.shouldDrop({ type: "reasoning-end", id: "r1" })).toBe(true);

    guard.shouldDrop({ type: "reasoning-start", id: "r2" });
    expect(guard.shouldDrop({ type: "finish" })).toBe(false);
    expect(guard.shouldDrop({ type: "reasoning-delta", id: "r2" })).toBe(
      true,
    );
  });

  it("leaves unrelated chunks alone", () => {
    const guard = createReasoningSequenceGuard();

    expect(guard.shouldDrop({ type: "text-start", id: "t1" })).toBe(false);
    expect(guard.shouldDrop({ type: "tool-output-available" })).toBe(false);
  });
});
