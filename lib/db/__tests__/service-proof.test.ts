import { webcrypto } from "node:crypto";
import { signServiceArgs, verifyServiceArgs } from "../service-proof";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
});
const scope = {
  deployment: "https://fixture.convex.cloud",
  name: "messages:saveMessage",
  type: "mutation" as const,
};
const secret = "synthetic-credential-only-for-tests";
const now = 1_800_000_000_000;

describe("request-bound service proofs", () => {
  it("removes the reusable secret and accepts the exact signed request", async () => {
    const signed = await signServiceArgs(
      scope,
      {
        serviceKey: secret,
        id: "message-1",
        nested: { b: 2, a: 1 },
        omitted: undefined,
      },
      now,
    );
    expect(JSON.stringify(signed)).not.toContain(secret);
    expect(await verifyServiceArgs(scope, signed, secret, now)).toBe(true);
    expect(
      await verifyServiceArgs(
        scope,
        { ...signed, nested: { a: 1, b: 2 } },
        secret,
        now,
      ),
    ).toBe(true);
  });

  it("accepts the verified Production alias but keeps Preview separate", async () => {
    const signed = await signServiceArgs(
      { ...scope, deployment: "https://convex.haiusercontent.com/" },
      { serviceKey: secret, id: "message-1" },
      now,
    );
    expect(
      await verifyServiceArgs(
        { ...scope, deployment: "https://greedy-cod-889.convex.cloud" },
        signed,
        secret,
        now,
      ),
    ).toBe(true);
    expect(await verifyServiceArgs(scope, signed, secret, now)).toBe(false);
  });

  it("cannot turn the original missing-id validation failure into a valid request", async () => {
    const signed = await signServiceArgs(
      scope,
      { serviceKey: secret, chatId: "test-id" },
      now,
    );
    expect(
      await verifyServiceArgs(
        scope,
        { ...signed, id: "inserted-id" },
        secret,
        now,
      ),
    ).toBe(false);
  });

  it.each([
    { ...scope, name: "users:updateUser" },
    { ...scope, type: "query" as const },
    { ...scope, deployment: "https://other.convex.cloud" },
  ])(
    "rejects a different function, operation or deployment: %j",
    async (other) => {
      const signed = await signServiceArgs(
        scope,
        { serviceKey: secret, id: "message-1" },
        now,
      );
      expect(await verifyServiceArgs(other, signed, secret, now)).toBe(false);
    },
  );

  it("expires and fails closed for raw, wrong, missing and research credentials", async () => {
    const args = { serviceKey: secret, id: "message-1" };
    const signed = await signServiceArgs(scope, args, now);
    expect(await verifyServiceArgs(scope, signed, secret, now + 60_001)).toBe(
      false,
    );
    expect(await verifyServiceArgs(scope, signed, secret, now - 10_001)).toBe(
      false,
    );
    expect(await verifyServiceArgs(scope, args, secret, now)).toBe(false);
    expect(await verifyServiceArgs(scope, signed, undefined, now)).toBe(false);
    expect(
      await verifyServiceArgs(scope, signed, "separate-research-secret", now),
    ).toBe(false);
  });

  it("preserves Convex int64, bytes, nonfinite numbers and array ordering", async () => {
    const args = {
      serviceKey: secret,
      n: BigInt(17),
      bytes: new Uint8Array([1, 2]).buffer,
      values: [NaN, Infinity, -0],
    };
    const signed = await signServiceArgs(scope, args, now);
    expect(await verifyServiceArgs(scope, signed, secret, now)).toBe(true);
    expect(
      await verifyServiceArgs(
        scope,
        { ...signed, values: [Infinity, NaN, -0] },
        secret,
        now,
      ),
    ).toBe(false);
  });
});
