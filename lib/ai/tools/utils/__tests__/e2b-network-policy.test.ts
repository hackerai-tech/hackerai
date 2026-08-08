import { composeE2BNetworkPolicy } from "../e2b-network-policy";

describe("E2B network policy composition", () => {
  it("composes an allow-only policy as one complete replace-all update", () => {
    const policy = composeE2BNetworkPolicy({
      outboundMode: "allow_only",
      destinations: ["api.example.com", "203.0.113.0/24"],
      updatedAt: 1,
    });

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
      outboundMode: "unrestricted",
      destinations: [],
      updatedAt: 2,
    });

    expect(policy.create).toEqual({});
    expect(policy.update).toEqual({});
  });
});
