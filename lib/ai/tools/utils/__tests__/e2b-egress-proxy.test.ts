import { getE2BEgressProxyForUser } from "../e2b-egress-proxy";

describe("E2B egress proxy configuration", () => {
  it("stays disabled without a proxy address", () => {
    expect(getE2BEgressProxyForUser("user-1", {})).toBeUndefined();
  });

  it("stays disabled when the user is not explicitly allowlisted", () => {
    expect(
      getE2BEgressProxyForUser("user-1", {
        E2B_EGRESS_PROXY_ADDRESS: "proxy.example.com:1080",
        E2B_EGRESS_PROXY_ALLOWED_USER_IDS: "user-2",
      }),
    ).toBeUndefined();
  });

  it("returns credentials only for an allowlisted user", () => {
    expect(
      getE2BEgressProxyForUser("user-1", {
        E2B_EGRESS_PROXY_ADDRESS: " proxy.example.com:1080 ",
        E2B_EGRESS_PROXY_USERNAME: "proxy-user",
        E2B_EGRESS_PROXY_PASSWORD: "proxy-password",
        E2B_EGRESS_PROXY_ALLOWED_USER_IDS: "user-2, user-1",
      }),
    ).toEqual({
      address: "proxy.example.com:1080",
      username: "proxy-user",
      password: "proxy-password",
    });
  });

  it("supports an explicit all-users rollout", () => {
    expect(
      getE2BEgressProxyForUser("user-1", {
        E2B_EGRESS_PROXY_ADDRESS: "proxy.example.com:1080",
        E2B_EGRESS_PROXY_ALLOWED_USER_IDS: "*",
      }),
    ).toEqual({ address: "proxy.example.com:1080" });
  });

  it("rejects credentials without an address", () => {
    expect(() =>
      getE2BEgressProxyForUser("user-1", {
        E2B_EGRESS_PROXY_USERNAME: "proxy-user",
      }),
    ).toThrow("credentials require E2B_EGRESS_PROXY_ADDRESS");
  });

  it("rejects a password without a username", () => {
    expect(() =>
      getE2BEgressProxyForUser("user-1", {
        E2B_EGRESS_PROXY_ADDRESS: "proxy.example.com:1080",
        E2B_EGRESS_PROXY_PASSWORD: "proxy-password",
      }),
    ).toThrow("E2B_EGRESS_PROXY_PASSWORD requires E2B_EGRESS_PROXY_USERNAME");
  });

  it("rejects SOCKS5 credentials longer than 255 UTF-8 bytes", () => {
    expect(() =>
      getE2BEgressProxyForUser("user-1", {
        E2B_EGRESS_PROXY_ADDRESS: "proxy.example.com:1080",
        E2B_EGRESS_PROXY_USERNAME: "a".repeat(256),
        E2B_EGRESS_PROXY_ALLOWED_USER_IDS: "user-1",
      }),
    ).toThrow("username exceeds 255 bytes");
  });
});
