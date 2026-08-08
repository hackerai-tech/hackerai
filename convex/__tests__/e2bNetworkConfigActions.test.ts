import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  action: jest.fn((config) => config),
}));

jest.mock("../_generated/api", () => ({
  internal: {
    e2bNetworkConfigs: {
      getForUser: "e2bNetworkConfigs.getForUser",
      upsertForUser: "e2bNetworkConfigs.upsertForUser",
    },
  },
}));

function createCtx(entitlements = ["pro-plan"]) {
  return {
    auth: {
      getUserIdentity: jest.fn(async () => ({
        subject: "user_123",
        entitlements,
      })),
    },
    runQuery: jest.fn(async () => null),
    runMutation: jest.fn(async () => null),
  };
}

describe("E2B network config actions", () => {
  beforeEach(() => {
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    jest.clearAllMocks();
  });

  it("normalizes and persists allow-only domains, IPs, and CIDRs", async () => {
    const { saveE2BNetworkConfig } = await import("../e2bNetworkConfigActions");
    const ctx = createCtx();

    const result = await saveE2BNetworkConfig.handler(ctx as any, {
      outboundMode: "allow_only",
      destinations: [
        "API.Example.com.",
        "*.GitHub.com",
        "203.0.113.10",
        "2001:db8::/64",
        "api.example.com",
      ],
    });

    expect(result).toMatchObject({
      outboundMode: "allow_only",
      destinations: [
        "api.example.com",
        "*.github.com",
        "203.0.113.10",
        "2001:db8::/64",
      ],
    });
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "e2bNetworkConfigs.upsertForUser",
      expect.objectContaining({
        userId: "user_123",
        destinations: result.destinations,
      }),
    );
  });

  it("rejects domains in block lists", async () => {
    const { saveE2BNetworkConfig } = await import("../e2bNetworkConfigActions");

    await expect(
      saveE2BNetworkConfig.handler(createCtx() as any, {
        outboundMode: "block_list",
        destinations: ["example.com"],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "INVALID_NETWORK_CONFIG" }),
    });
  });

  it.each([
    ["URLs", "https://example.com"],
    ["ports", "example.com:443"],
    ["malformed IP addresses", "999.1.1.1"],
    ["invalid CIDR prefixes", "203.0.113.0/33"],
    ["single-label hostnames", "localhost"],
  ])("rejects %s", async (_label, destination) => {
    const { saveE2BNetworkConfig } = await import("../e2bNetworkConfigActions");

    await expect(
      saveE2BNetworkConfig.handler(createCtx() as any, {
        outboundMode: "allow_only",
        destinations: [destination],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "INVALID_NETWORK_CONFIG" }),
    });
  });

  it("enforces the destination limit after authorization", async () => {
    const { saveE2BNetworkConfig } = await import("../e2bNetworkConfigActions");

    await expect(
      saveE2BNetworkConfig.handler(createCtx() as any, {
        outboundMode: "allow_only",
        destinations: Array.from(
          { length: 51 },
          (_, index) => `host-${index}.example.com`,
        ),
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "INVALID_NETWORK_CONFIG" }),
    });
  });

  it("rejects unauthenticated settings reads", async () => {
    const { getE2BNetworkConfig } = await import("../e2bNetworkConfigActions");
    const ctx = createCtx();
    ctx.auth.getUserIdentity.mockResolvedValueOnce(null as never);

    await expect(
      getE2BNetworkConfig.handler(ctx as any, {}),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "UNAUTHORIZED" }),
    });
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });

  it("rejects free users before reading or writing settings", async () => {
    const { getE2BNetworkConfig, saveE2BNetworkConfig } =
      await import("../e2bNetworkConfigActions");
    const ctx = createCtx([]);

    await expect(
      getE2BNetworkConfig.handler(ctx as any, {}),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "PAID_PLAN_REQUIRED" }),
    });
    await expect(
      saveE2BNetworkConfig.handler(ctx as any, {
        outboundMode: "unrestricted",
        destinations: [],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "PAID_PLAN_REQUIRED" }),
    });
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("requires the service key for runtime reads", async () => {
    const { getE2BNetworkConfigForBackend } =
      await import("../e2bNetworkConfigActions");

    await expect(
      getE2BNetworkConfigForBackend.handler(createCtx() as any, {
        serviceKey: "wrong",
        userId: "user_123",
        subscription: "pro",
      }),
    ).rejects.toThrow("Unauthorized: Invalid service key");
  });
});
