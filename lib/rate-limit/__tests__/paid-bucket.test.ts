import { describe, expect, it, jest } from "@jest/globals";
import { limitPaidBucket } from "../paid-bucket";
import type { Redis } from "@upstash/redis";

describe("paid bucket adapter", () => {
  it("returns a rejected debit with its unchanged balance", async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValue([0, 50, 1790812800000, 200000]);
    const result = await limitPaidBucket(
      { eval: evalMock } as unknown as Pick<Redis, "eval">,
      "usage:monthly:user_1:pro",
      250000,
      70,
    );
    expect(result).toEqual({
      success: false,
      remaining: 50,
      reset: 1790812800000,
      limit: 200000,
    });
  });

  it("reports the exact partial debit for final settlement", async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValue([0, 0, 1790812800000, 100, 40]);
    const result = await limitPaidBucket(
      { eval: evalMock } as unknown as Pick<Redis, "eval">,
      "usage:monthly:user_1:pro",
      100,
      100,
      1790700000000,
      true,
    );
    expect(result).toMatchObject({
      success: false,
      remaining: 0,
      deducted: 40,
    });
  });

  it.each([-1, NaN, Infinity])(
    "rejects invalid debit %s before contacting Redis",
    async (debit) => {
      const evalMock = jest.fn();
      await expect(
        limitPaidBucket(
          { eval: evalMock } as unknown as Pick<Redis, "eval">,
          "usage:monthly:user_1:pro",
          250000,
          debit,
        ),
      ).rejects.toThrow("Invalid paid usage debit");
      expect(evalMock).not.toHaveBeenCalled();
    },
  );

  it("propagates storage errors so callers cannot claim successful billing", async () => {
    const evalMock = jest
      .fn()
      .mockRejectedValue(new Error("Redis unavailable"));
    await expect(
      limitPaidBucket(
        { eval: evalMock } as unknown as Pick<Redis, "eval">,
        "usage:monthly:user_1:pro",
        250000,
      ),
    ).rejects.toThrow("Redis unavailable");
  });
});
