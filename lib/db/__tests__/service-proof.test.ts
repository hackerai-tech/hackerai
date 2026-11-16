import { webcrypto } from "node:crypto";
import {
  signServiceArgs,
  verifyServiceArgs,
  type ServiceProofObservation,
} from "../service-proof";

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

const observe = async (
  args: Record<string, unknown>,
  configured: string | undefined,
  at: number | undefined,
) => {
  const seen: ServiceProofObservation[] = [];
  const result = await verifyServiceArgs(scope, args, configured, at, (o) => {
    seen.push(o);
  });
  return { result, seen };
};

// Configured, missing and empty secrets must be indistinguishable to anyone
// who can see the observation for a rejected request.
const secretStates = [secret, undefined, ""] as const;

const credentialGetter = (read: () => unknown) => {
  let reads = 0;
  const args: Record<string, unknown> = { id: "message-1" };
  Object.defineProperty(args, "serviceKey", {
    enumerable: true,
    get: () => {
      reads += 1;
      return read();
    },
  });
  return { args, reads: () => reads };
};

describe("public-input observation of rejected service proofs", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is identical for configured and unconfigured secrets on every rejected input", async () => {
    const signed = await signServiceArgs(
      scope,
      { serviceKey: secret, id: "message-1" },
      now,
    );
    const proof = signed.serviceKey as string;
    const cases: Array<
      [string, Record<string, unknown>, number, ServiceProofObservation]
    > = [
      ["absent", { id: "message-1" }, now, "credential_not_string"],
      ["null", { serviceKey: null }, now, "credential_not_string"],
      ["number", { serviceKey: 17 }, now, "credential_not_string"],
      ["array", { serviceKey: [proof] }, now, "credential_not_string"],
      [
        "object whose coercion throws",
        {
          serviceKey: {
            toString: () => {
              throw new Error("coerced");
            },
          },
        },
        now,
        "credential_not_string",
      ],
      ["empty", { serviceKey: "" }, now, "proof_malformed"],
      ["correct raw key", { serviceKey: secret }, now, "proof_malformed"],
      [
        "garbage of the raw key's length",
        { serviceKey: "x".repeat(secret.length) },
        now,
        "proof_malformed",
      ],
      [
        "proof-length uppercase signature",
        { serviceKey: `hmac1.${now}.${"A".repeat(64)}` },
        now,
        "proof_malformed",
      ],
      [
        "short timestamp",
        { serviceKey: `hmac1.${String(now).slice(1)}.${"0".repeat(64)}` },
        now,
        "proof_malformed",
      ],
      [
        "trailing newline",
        { serviceKey: `${proof}\n` },
        now,
        "proof_malformed",
      ],
      [
        "overlong",
        { serviceKey: `hmac1.${"9".repeat(100_000)}` },
        now,
        "proof_malformed",
      ],
      ["expired", signed, now + 60_001, "proof_expired"],
      ["future", signed, now - 10_001, "proof_future"],
      [
        "fresh forged signature",
        { serviceKey: `hmac1.${now}.${"0".repeat(64)}`, id: "message-1" },
        now,
        "verification_failed",
      ],
      [
        "fresh proof for other arguments",
        { ...signed, id: "message-2" },
        now,
        "verification_failed",
      ],
    ];
    for (const [label, args, at, expected] of cases) {
      const outcomes = await Promise.all(
        secretStates.map((configured) => observe(args, configured, at)),
      );
      for (const outcome of outcomes) {
        expect({ label, ...outcome }).toEqual({
          label,
          result: false,
          seen: [expected],
        });
      }
    }
  });

  it("keeps TTL and skew boundaries and observes one millisecond beyond", async () => {
    const signed = await signServiceArgs(
      scope,
      { serviceKey: secret, id: "message-1" },
      now,
    );
    const onReject = jest.fn();
    for (const at of [now + 60_000, now - 10_000]) {
      expect(await verifyServiceArgs(scope, signed, secret, at)).toBe(true);
      expect(await verifyServiceArgs(scope, signed, secret, at, onReject)).toBe(
        true,
      );
      // Without a secret the same acceptable proof only reports public shape.
      expect(await observe(signed, undefined, at)).toEqual({
        result: false,
        seen: ["verification_failed"],
      });
    }
    expect(onReject).not.toHaveBeenCalled();
    for (const configured of secretStates) {
      expect(await observe(signed, configured, now + 60_001)).toEqual({
        result: false,
        seen: ["proof_expired"],
      });
      expect(await observe(signed, configured, now - 10_001)).toEqual({
        result: false,
        seen: ["proof_future"],
      });
    }
  });

  it("classifies with the verifier's single default clock reading", async () => {
    const signed = await signServiceArgs(
      scope,
      { serviceKey: secret, id: "message-1" },
      now,
    );
    const clock = jest.spyOn(Date, "now").mockReturnValue(now + 60_001);
    for (const configured of secretStates) {
      clock.mockClear();
      expect(await observe(signed, configured, undefined)).toEqual({
        result: false,
        seen: ["proof_expired"],
      });
      expect(clock).toHaveBeenCalledTimes(1);
    }
  });

  it("does no extra credential reads without an observer", async () => {
    const unset = credentialGetter(() => {
      throw new Error("must not be read");
    });
    await expect(
      verifyServiceArgs(scope, unset.args, undefined, now),
    ).resolves.toBe(false);
    expect(unset.reads()).toBe(0);
    const malformed = credentialGetter(() => "not-a-proof");
    await expect(
      verifyServiceArgs(scope, malformed.args, secret, now),
    ).resolves.toBe(false);
    // The original type check and parse, nothing more.
    expect(malformed.reads()).toBe(2);
  });

  it("keeps false and a generic observation when diagnostics throw", async () => {
    const throwing = credentialGetter(() => {
      throw new Error(`diagnostic read ${secret}`);
    });
    const onReject = jest.fn();
    await expect(
      verifyServiceArgs(scope, throwing.args, undefined, now, onReject),
    ).resolves.toBe(false);
    expect(onReject.mock.calls).toEqual([["verification_failed"]]);

    const failingObserver = jest.fn(() => {
      throw new Error("observer failed");
    });
    for (const configured of secretStates) {
      await expect(
        verifyServiceArgs(
          scope,
          { serviceKey: "bad" },
          configured,
          now,
          failingObserver,
        ),
      ).resolves.toBe(false);
    }
    expect(failingObserver).toHaveBeenCalledTimes(secretStates.length);
  });

  it.each(["importKey", "verify"] as const)(
    "propagates the exact %s exception without observing it",
    async (method) => {
      const signed = await signServiceArgs(
        scope,
        { serviceKey: secret, id: "message-1" },
        now,
      );
      const failure = new Error(`${method} failed`);
      jest.spyOn(crypto.subtle, method).mockRejectedValueOnce(failure);
      const onReject = jest.fn();
      await expect(
        verifyServiceArgs(scope, signed, secret, now, onReject),
      ).rejects.toBe(failure);
      expect(onReject).not.toHaveBeenCalled();
    },
  );

  it("propagates the exact payload exception without observing it", async () => {
    const signed = await signServiceArgs(
      scope,
      { serviceKey: secret, id: "message-1" },
      now,
    );
    const failure = new Error("payload failed");
    const args = { ...signed };
    Object.defineProperty(args, "extra", {
      enumerable: true,
      get: () => {
        throw failure;
      },
    });
    const onReject = jest.fn();
    await expect(
      verifyServiceArgs(scope, args, secret, now, onReject),
    ).rejects.toBe(failure);
    expect(onReject).not.toHaveBeenCalled();
  });
});
