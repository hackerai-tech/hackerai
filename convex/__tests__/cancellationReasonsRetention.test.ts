import { describe, it, expect, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalQuery: jest.fn((config: any) => config),
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    array: jest.fn(() => "array"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
    null: jest.fn(() => "null"),
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

function ctxWith(row: Record<string, unknown> | null) {
  const patch = jest.fn(async () => undefined);
  return {
    ctx: { db: { get: jest.fn(async () => row), patch } },
    patch,
  };
}

describe("recordRetentionOfferAccepted", () => {
  it("marks a started row retained for a downgrade", async () => {
    const { recordRetentionOfferAccepted } =
      await import("../cancellationReasons");
    const { ctx, patch } = ctxWith({ _id: "r1", status: "started" });

    const result = await (recordRetentionOfferAccepted as any).handler(ctx, {
      serviceKey: "k",
      cancellationReasonId: "r1",
      retentionOffer: "downgrade",
      acceptedAt: 5,
    });

    expect(result).toEqual({ recorded: true });
    expect(patch).toHaveBeenCalledWith("r1", {
      retention_offer_accepted: "downgrade",
      status: "retained",
      updated_at: 5,
    });
  });

  it("keeps a pause row started and treats a repeat as idempotent", async () => {
    const { recordRetentionOfferAccepted } =
      await import("../cancellationReasons");
    const first = ctxWith({ _id: "r1", status: "started" });
    await (recordRetentionOfferAccepted as any).handler(first.ctx, {
      serviceKey: "k",
      cancellationReasonId: "r1",
      retentionOffer: "pause",
    });
    expect(first.patch).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ retention_offer_accepted: "pause" }),
    );
    expect(first.patch.mock.calls[0][1]).not.toHaveProperty("status");

    const repeat = ctxWith({
      _id: "r1",
      status: "started",
      retention_offer_accepted: "pause",
    });
    await expect(
      (recordRetentionOfferAccepted as any).handler(repeat.ctx, {
        serviceKey: "k",
        cancellationReasonId: "r1",
        retentionOffer: "pause",
      }),
    ).resolves.toEqual({ recorded: true });
    expect(repeat.patch).not.toHaveBeenCalled();
  });

  it("rejects a different offer or a row that already left started", async () => {
    const { recordRetentionOfferAccepted } =
      await import("../cancellationReasons");
    const conflicting = ctxWith({
      _id: "r1",
      status: "retained",
      retention_offer_accepted: "downgrade",
    });
    await expect(
      (recordRetentionOfferAccepted as any).handler(conflicting.ctx, {
        serviceKey: "k",
        cancellationReasonId: "r1",
        retentionOffer: "pause",
      }),
    ).resolves.toEqual({
      recorded: false,
      reason: "different_offer_accepted",
    });
    expect(conflicting.patch).not.toHaveBeenCalled();

    const completed = ctxWith({ _id: "r1", status: "completed" });
    await expect(
      (recordRetentionOfferAccepted as any).handler(completed.ctx, {
        serviceKey: "k",
        cancellationReasonId: "r1",
        retentionOffer: "downgrade",
      }),
    ).resolves.toEqual({ recorded: false, reason: "already_decided" });
    expect(completed.patch).not.toHaveBeenCalled();
  });
});
