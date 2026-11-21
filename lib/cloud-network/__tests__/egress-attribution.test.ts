/** @jest-environment node */
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { createRedisClient } from "@/lib/rate-limit/redis";
import fixture from "../../../scripts/egress/tests/credentials.json";
import {
  ATTRIBUTION_REGISTRY_TTL_S,
  attributedCredential,
  EgressAttributionConflictError,
  parseEgressAttribution,
  registerAttributedWorkspace,
  resolveAttribution,
  selectWorkspaceEgress,
} from "../egress-attribution";

const KEYS = {
  us: Buffer.from(fixture.attributionKeys.us, "hex"),
  eu: Buffer.from(fixture.attributionKeys.eu, "hex"),
};
const [first, second, europe] = fixture.vectors;

it.each([false, true])(
  "preserves the current credential when registry registration stalls (pinned=%s)",
  async (pinned) => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const redis = fakeRedis();
    redis.set.mockImplementation(() => new Promise(() => {}));
    const proxy = {
      address: "socks5://proxy.example.test:1080",
      username: "shared",
      password: "shared-password",
    };
    const egress = {
      proxy,
      destinations: "*" as const,
      attribution: { region: "us" as const, key: KEYS.us, enrolled: true },
    };
    const actual = {
      address: proxy.address,
      username: pinned ? first.username : proxy.username,
    };
    try {
      const pending = selectWorkspaceEgress(
        egress,
        actual,
        first.userId,
        first.sandboxId,
      );
      await jest.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(result.egress?.proxy).toEqual(
        pinned
          ? { ...proxy, username: first.username, password: first.password }
          : proxy,
      );
      expect(result.replacesShared).toBe(false);
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  },
);

/** Upstash-like store: values are JSON-deserialized on read. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  const read = (key: string) => {
    const value = store.get(key);
    return value === undefined ? null : JSON.parse(value);
  };
  const redis = {
    store,
    ttl,
    set: jest.fn(
      async (
        key: string,
        value: string,
        opts?: { nx?: boolean; ex?: number },
      ) => {
        if (opts?.nx && store.has(key)) return null;
        store.set(key, value);
        if (opts?.ex) ttl.set(key, opts.ex);
        return "OK";
      },
    ),
    get: jest.fn(async (key: string) => read(key)),
    mget: jest.fn(async (...keys: string[]) => keys.map(read)),
    expire: jest.fn(async (key: string, seconds: number) => {
      ttl.set(key, seconds);
      return 1;
    }),
  };
  jest.mocked(createRedisClient).mockReturnValue(redis as never);
  return redis;
}

describe("attributed credentials", () => {
  // The PAM module and the Python fixture check the same vectors, so these
  // pin the shared derivation rather than this implementation.
  it.each(fixture.vectors)(
    "derives the shared $region vector for $sandboxId",
    ({ region, userId, sandboxId, ...expected }) => {
      const credential = attributedCredential(
        KEYS[region as "us" | "eu"],
        region as "us" | "eu",
        userId,
        sandboxId,
      );
      expect(credential).toEqual(expected);
      expect(credential!.username).toMatch(
        /^hae-v1-[0-9a-f]{32}-[0-9a-f]{32}$/,
      );
      // SOCKS5 username/password fields carry at most 255 bytes each.
      expect(Buffer.byteLength(credential!.username)).toBeLessThanOrEqual(255);
      expect(Buffer.byteLength(credential!.password)).toBeLessThanOrEqual(255);
    },
  );

  it("keeps one owner reference across workspaces and separates regions", () => {
    expect(first.owner).toBe(second.owner);
    expect(first.workspace).not.toBe(second.workspace);
    // The same identifiers under the other region's key share nothing.
    const crossed = attributedCredential(
      KEYS.eu,
      "eu",
      first.userId,
      first.sandboxId,
    )!;
    expect(crossed.owner).not.toBe(first.owner);
    expect(crossed.workspace).not.toBe(first.workspace);
    expect(crossed.password).not.toBe(first.password);
    // Region is bound into the password even with the same key.
    expect(
      attributedCredential(KEYS.us, "eu", first.userId, first.sandboxId)!
        .password,
    ).not.toBe(first.password);
    expect(europe.owner).not.toBe(first.owner);
  });

  it("separates owners that share a sandbox identifier", () => {
    const other = attributedCredential(
      KEYS.us,
      "us",
      "user_other",
      first.sandboxId,
    )!;
    expect(other.owner).not.toBe(first.owner);
    expect(other.workspace).not.toBe(first.workspace);
  });

  it.each(["", "a\nb", "x".repeat(129), "user id", "üser"])(
    "leaves identifier %p unattributed",
    (value) => {
      expect(attributedCredential(KEYS.us, "us", value, "sandbox")).toBeNull();
      expect(attributedCredential(KEYS.us, "us", "user", value)).toBeNull();
    },
  );
});

describe("attribution configuration", () => {
  const keys = {
    E2B_EGRESS_ATTRIBUTION_US_KEY: fixture.attributionKeys.us,
    E2B_EGRESS_ATTRIBUTION_EU_KEY: fixture.attributionKeys.eu,
  };

  it("is off without any attribution variables", () => {
    expect(parseEgressAttribution("owner", {})).toBeNull();
    expect(
      parseEgressAttribution("owner", {
        E2B_EGRESS_ATTRIBUTION_ENABLED: "false",
      }),
    ).toBeNull();
  });

  it.each([
    ["the pilot list", { E2B_EGRESS_ATTRIBUTION_USERS: "other, owner" }, true],
    ["global enrollment", { E2B_EGRESS_ATTRIBUTION_ENABLED: "true" }, true],
    // Keys alone recognize existing attributed workspaces without enrolling.
    [
      "keys without enrollment",
      { E2B_EGRESS_ATTRIBUTION_USERS: "other" },
      false,
    ],
  ])("parses %s", (_label, env, enrolled) => {
    const config = parseEgressAttribution("owner", {
      ...keys,
      // Independent telemetry keys in the same process are accepted.
      E2B_EGRESS_TELEMETRY_US_KEY: fixture.telemetryKeys.us,
      E2B_EGRESS_TELEMETRY_EU_KEY: fixture.telemetryKeys.eu,
      ...env,
    });
    expect(config?.enrolled).toBe(enrolled);
    expect(config?.keys.us.toString("hex")).toBe(fixture.attributionKeys.us);
    expect(config?.keys.eu.toString("hex")).toBe(fixture.attributionKeys.eu);
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ["enrollment without keys", { E2B_EGRESS_ATTRIBUTION_USERS: "owner" }],
    ["an invalid toggle", { ...keys, E2B_EGRESS_ATTRIBUTION_ENABLED: "TRUE" }],
    [
      "one regional key",
      { E2B_EGRESS_ATTRIBUTION_US_KEY: keys.E2B_EGRESS_ATTRIBUTION_US_KEY },
    ],
    [
      "an uppercase key",
      {
        ...keys,
        E2B_EGRESS_ATTRIBUTION_EU_KEY: fixture.attributionKeys.eu.toUpperCase(),
      },
    ],
    [
      "a short key",
      { ...keys, E2B_EGRESS_ATTRIBUTION_US_KEY: "1f".repeat(31) },
    ],
    [
      "one key for both regions",
      {
        ...keys,
        E2B_EGRESS_ATTRIBUTION_EU_KEY: keys.E2B_EGRESS_ATTRIBUTION_US_KEY,
      },
    ],
    // Attribution and telemetry keys are generated independently.
    [
      "an attribution key reused for telemetry",
      {
        ...keys,
        E2B_EGRESS_TELEMETRY_EU_KEY: keys.E2B_EGRESS_ATTRIBUTION_US_KEY,
      },
    ],
  ])("rejects %s", (_label, env) => {
    expect(() => parseEgressAttribution("owner", env)).toThrow();
  });
});

describe("attribution registry", () => {
  const credential = {
    owner: first.owner,
    workspace: first.workspace,
    username: first.username,
    password: first.password,
  };

  it("registers and refreshes the verified owner and sandbox with a bounded lifetime", async () => {
    const redis = fakeRedis();
    await registerAttributedWorkspace(
      "us",
      credential,
      first.userId,
      first.sandboxId,
    );
    await registerAttributedWorkspace(
      "us",
      credential,
      first.userId,
      first.sandboxId,
    );
    expect([...redis.ttl.values()]).toEqual([
      ATTRIBUTION_REGISTRY_TTL_S,
      ATTRIBUTION_REGISTRY_TTL_S,
    ]);
    expect(redis.expire).toHaveBeenCalledTimes(2);
    expect(
      await resolveAttribution(redis as never, "us", first.owner, [
        first.workspace,
      ]),
    ).toEqual({
      userId: first.userId,
      sandboxIds: [first.sandboxId],
      unverifiedWorkspaces: 0,
    });
    // Stored per region: the EU registry knows nothing about it.
    expect(
      (
        await resolveAttribution(redis as never, "eu", first.owner, [
          first.workspace,
        ])
      ).userId,
    ).toBeUndefined();
    expect(JSON.stringify([...redis.store])).not.toContain(first.password);
  });

  it.each([
    [
      "owner reference",
      "egress-attribution:v1:us:owner:",
      { userId: "user_other" },
    ],
    [
      "workspace reference",
      "egress-attribution:v1:us:workspace:",
      {
        userId: first.userId,
        sandboxId: "another-sandbox",
        owner: first.owner,
      },
    ],
  ])(
    "rejects an existing %s mapped to someone else",
    async (_label, prefix, value) => {
      const redis = fakeRedis();
      const ref = prefix.includes("owner") ? first.owner : first.workspace;
      redis.store.set(`${prefix}${ref}`, JSON.stringify(value));
      await expect(
        registerAttributedWorkspace(
          "us",
          credential,
          first.userId,
          first.sandboxId,
        ),
      ).rejects.toBeInstanceOf(EgressAttributionConflictError);
      expect(redis.store.get(`${prefix}${ref}`)).toBe(JSON.stringify(value));
    },
  );

  it("reports only workspaces registered to the resolved owner", async () => {
    const redis = fakeRedis();
    await registerAttributedWorkspace(
      "us",
      credential,
      first.userId,
      first.sandboxId,
    );
    redis.store.set(
      `egress-attribution:v1:us:workspace:${second.workspace}`,
      JSON.stringify({
        userId: "user_other",
        sandboxId: "foreign",
        owner: first.owner,
      }),
    );
    expect(
      await resolveAttribution(redis as never, "us", first.owner, [
        first.workspace,
        second.workspace,
        "0".repeat(32),
      ]),
    ).toEqual({
      userId: first.userId,
      sandboxIds: [first.sandboxId],
      unverifiedWorkspaces: 2,
    });
  });

  it("fails registration when the store is unavailable", async () => {
    jest.mocked(createRedisClient).mockReturnValue(null);
    await expect(
      registerAttributedWorkspace(
        "us",
        credential,
        first.userId,
        first.sandboxId,
      ),
    ).rejects.toThrow("unavailable");
  });
});
