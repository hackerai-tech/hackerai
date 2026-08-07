import {
  decryptProxyConfig,
  encryptProxyConfig,
} from "../lib/proxyConfigCrypto";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 8).toString("base64");

describe("proxy config encryption", () => {
  const config = {
    host: "proxy.example.com",
    port: 1080,
    username: "alice",
    password: "highly-secret",
    proxyDns: true,
    bypassHosts: ["internal.example.com"],
  };

  it("round-trips an encrypted proxy config without exposing plaintext", () => {
    const encrypted = encryptProxyConfig(config, "user_123", KEY);

    expect(encrypted).not.toContain(config.host);
    expect(encrypted).not.toContain(config.password);
    expect(decryptProxyConfig(encrypted, "user_123", KEY)).toEqual(config);
  });

  it("binds ciphertext to the user and encryption key", () => {
    const encrypted = encryptProxyConfig(config, "user_123", KEY);

    expect(() => decryptProxyConfig(encrypted, "user_other", KEY)).toThrow();
    expect(() =>
      decryptProxyConfig(encrypted, "user_123", OTHER_KEY),
    ).toThrow();
  });

  it("rejects keys that are not exactly 32 bytes", () => {
    expect(() =>
      encryptProxyConfig(
        config,
        "user_123",
        Buffer.alloc(16).toString("base64"),
      ),
    ).toThrow("base64-encoded 32-byte key");
  });
});
