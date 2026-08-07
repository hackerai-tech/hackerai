import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  decryptProxyConfig,
  encryptProxyConfig,
} from "../lib/proxyConfigCrypto";

jest.mock("../_generated/server", () => ({
  action: jest.fn((config) => config),
}));

jest.mock("../_generated/api", () => ({
  internal: {
    proxyConfigs: {
      getEncryptedForUser: "getEncryptedForUser",
      upsertEncryptedForUser: "upsertEncryptedForUser",
      deleteForUser: "deleteForUser",
    },
  },
}));

const KEY = Buffer.alloc(32, 4).toString("base64");

function createCtx(existing: unknown = null) {
  return {
    auth: {
      getUserIdentity: jest
        .fn<() => Promise<{ subject: string } | null>>()
        .mockResolvedValue({ subject: "user_123" }),
    },
    runQuery: jest.fn<() => Promise<unknown>>().mockResolvedValue(existing),
    runMutation: jest.fn<() => Promise<null>>().mockResolvedValue(null),
  };
}

describe("proxy config actions", () => {
  beforeEach(() => {
    process.env.USER_PROXY_CONFIG_ENCRYPTION_KEY = KEY;
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
  });

  it("encrypts credentials and never returns the password to the client", async () => {
    const { saveProxyConfig } = await import("../proxyConfigActions");
    const ctx = createCtx();

    const result = await saveProxyConfig.handler(ctx as any, {
      enabled: true,
      protocol: "http",
      host: "Proxy.Example.com",
      port: 8443,
      username: "alice",
      password: "secret-value",
      proxyDns: true,
      bypassHosts: ["Internal.Example.com"],
    });

    expect(result).toMatchObject({
      enabled: true,
      host: "proxy.example.com",
      hasPassword: true,
      bypassHosts: ["internal.example.com"],
    });
    expect(result).not.toHaveProperty("password");

    const mutationArgs = (ctx.runMutation as jest.Mock).mock.calls[0][1] as {
      encryptedConfig: string;
    };
    expect(mutationArgs.encryptedConfig).not.toContain("secret-value");
    expect(
      decryptProxyConfig(mutationArgs.encryptedConfig, "user_123", KEY),
    ).toMatchObject({ password: "secret-value" });
  });

  it("retains an existing password when the replacement is omitted", async () => {
    const { saveProxyConfig } = await import("../proxyConfigActions");
    const existing = {
      enabled: true,
      protocol: "socks5" as const,
      encryptedConfig: encryptProxyConfig(
        {
          host: "old.example.com",
          port: 1080,
          username: "alice",
          password: "existing-secret",
          proxyDns: true,
          bypassHosts: [],
        },
        "user_123",
        KEY,
      ),
      updatedAt: 1,
    };
    const ctx = createCtx(existing);

    await saveProxyConfig.handler(ctx as any, {
      enabled: true,
      protocol: "socks5",
      host: "new.example.com",
      port: 1081,
      username: "alice",
      proxyDns: true,
      bypassHosts: [],
    });

    const mutationArgs = (ctx.runMutation as jest.Mock).mock.calls[0][1] as {
      encryptedConfig: string;
    };
    expect(
      decryptProxyConfig(mutationArgs.encryptedConfig, "user_123", KEY),
    ).toMatchObject({
      host: "new.example.com",
      password: "existing-secret",
    });
  });

  it("returns decrypted credentials only through the service-key backend action", async () => {
    const { getProxyConfigForBackend } = await import("../proxyConfigActions");
    const existing = {
      enabled: true,
      protocol: "socks5" as const,
      encryptedConfig: encryptProxyConfig(
        {
          host: "proxy.example.com",
          port: 1080,
          password: "service-only",
          proxyDns: true,
          bypassHosts: [],
        },
        "user_123",
        KEY,
      ),
      updatedAt: 7,
    };
    const ctx = createCtx(existing);

    await expect(
      getProxyConfigForBackend.handler(ctx as any, {
        serviceKey: "wrong",
        userId: "user_123",
      }),
    ).rejects.toThrow("Invalid service key");

    await expect(
      getProxyConfigForBackend.handler(ctx as any, {
        serviceKey: "service_key",
        userId: "user_123",
      }),
    ).resolves.toMatchObject({
      password: "service-only",
      protocol: "socks5",
      updatedAt: 7,
    });
  });
});
