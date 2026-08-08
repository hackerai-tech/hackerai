import {
  composeE2BNetworkPolicy,
  getExistingE2BInboundMode,
} from "../e2b-network-policy";

describe("E2B network policy composition", () => {
  it("composes an allow-only policy as one complete replace-all update", () => {
    const policy = composeE2BNetworkPolicy({
      inboundMode: "token_required",
      outboundMode: "allow_only",
      destinations: ["api.example.com", "203.0.113.0/24"],
      updatedAt: 1,
    });

    expect(policy.create.allowPublicTraffic).toBe(false);
    expect(policy.create.allowOut).toEqual([
      "api.example.com",
      "203.0.113.0/24",
    ]);
    expect(
      typeof policy.update.denyOut === "function"
        ? policy.update.denyOut({ allTraffic: "0.0.0.0/0", rules: new Map() })
        : policy.update.denyOut,
    ).toEqual(["0.0.0.0/0"]);
  });

  it("uses an empty update to clear all egress rules for unrestricted mode", () => {
    const policy = composeE2BNetworkPolicy({
      inboundMode: "public",
      outboundMode: "unrestricted",
      destinations: [],
      updatedAt: 2,
    });

    expect(policy.create).toEqual({ allowPublicTraffic: true });
    expect(policy.update).toEqual({});
  });

  it("treats legacy sandboxes as public", () => {
    expect(getExistingE2BInboundMode(undefined)).toBe("public");
    expect(getExistingE2BInboundMode({ sandboxVersion: "v12" })).toBe("public");
    expect(
      getExistingE2BInboundMode({ networkInboundMode: "token_required" }),
    ).toBe("token_required");
  });
});
