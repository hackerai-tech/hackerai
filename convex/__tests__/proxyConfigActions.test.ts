import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockReadObjectByName = jest.fn();
const mockCreateObject = jest.fn();
const mockUpdateObject = jest.fn();
const mockDeleteObject = jest.fn();

jest.mock("../_generated/server", () => ({
  action: jest.fn((config) => config),
}));

jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn().mockImplementation(() => ({
    vault: {
      readObjectByName: mockReadObjectByName,
      createObject: mockCreateObject,
      updateObject: mockUpdateObject,
      deleteObject: mockDeleteObject,
    },
  })),
}));

type StoredConfig = {
  schemaVersion: 1;
  enabled: boolean;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxyDns: boolean;
  bypassHosts: string[];
  updatedAt: number;
};

function missingVaultObjectError() {
  const error = new Error("Vault object not found");
  error.name = "NotFoundException";
  return error;
}

function vaultObject(config: Partial<StoredConfig> = {}) {
  const value: StoredConfig = {
    schemaVersion: 1,
    enabled: true,
    protocol: "socks5",
    host: "proxy.example.com",
    port: 1080,
    proxyDns: true,
    bypassHosts: [],
    updatedAt: 7,
    ...config,
  };

  return {
    id: "secret_proxy_123",
    name: "hackerai-agent-proxy:user_123",
    value: JSON.stringify(value),
    metadata: { versionId: "version_1" },
  };
}

function createCtx() {
  return {
    auth: {
      getUserIdentity: jest
        .fn<
          () => Promise<{
            subject: string;
            entitlements: string[];
          } | null>
        >()
        .mockResolvedValue({
          subject: "user_123",
          entitlements: ["pro-plan"],
        }),
    },
  };
}

describe("proxy config actions", () => {
  beforeEach(() => {
    process.env.WORKOS_API_KEY = "workos_test";
    process.env.WORKOS_CLIENT_ID = "client_test";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    mockReadObjectByName.mockReset();
    mockCreateObject.mockReset().mockResolvedValue({ id: "secret_proxy_123" });
    mockUpdateObject.mockReset().mockResolvedValue(vaultObject());
    mockDeleteObject.mockReset().mockResolvedValue(undefined);
    mockReadObjectByName.mockRejectedValue(missingVaultObjectError());
  });

  it("stores credentials in a user-scoped WorkOS Vault object and never returns the password", async () => {
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
    expect(mockCreateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "hackerai-agent-proxy:user_123",
        context: {
          user_id: "user_123",
          data_type: "agent_proxy",
        },
      }),
    );
    const created = mockCreateObject.mock.calls[0][0] as { value: string };
    expect(JSON.parse(created.value)).toMatchObject({
      schemaVersion: 1,
      password: "secret-value",
      protocol: "http",
    });
  });

  it("retains an existing password and uses optimistic locking on update", async () => {
    const { saveProxyConfig } = await import("../proxyConfigActions");
    mockReadObjectByName.mockResolvedValue(
      vaultObject({ username: "alice", password: "existing-secret" }),
    );
    const ctx = createCtx();

    await saveProxyConfig.handler(ctx as any, {
      enabled: true,
      protocol: "socks5",
      host: "new.example.com",
      port: 1081,
      username: "alice",
      proxyDns: true,
      bypassHosts: [],
    });

    expect(mockUpdateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "secret_proxy_123",
        versionCheck: "version_1",
      }),
    );
    const updated = mockUpdateObject.mock.calls[0][0] as { value: string };
    expect(JSON.parse(updated.value)).toMatchObject({
      host: "new.example.com",
      password: "existing-secret",
    });
  });

  it("rejects free users before reading or saving proxy configuration", async () => {
    const { saveProxyConfig } = await import("../proxyConfigActions");
    const ctx = createCtx();
    ctx.auth.getUserIdentity.mockResolvedValue({
      subject: "user_123",
      entitlements: [],
    });

    await expect(
      saveProxyConfig.handler(ctx as any, {
        enabled: true,
        protocol: "http",
        host: "proxy.example.com",
        port: 8443,
        proxyDns: true,
        bypassHosts: [],
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "PAID_PLAN_REQUIRED" }),
    });
    expect(mockReadObjectByName).not.toHaveBeenCalled();
    expect(mockCreateObject).not.toHaveBeenCalled();
    expect(mockUpdateObject).not.toHaveBeenCalled();
  });

  it("returns Vault credentials only through the service-key backend action", async () => {
    const { getProxyConfigForBackend } = await import("../proxyConfigActions");
    mockReadObjectByName.mockResolvedValue(
      vaultObject({ username: "alice", password: "service-only" }),
    );
    const ctx = createCtx();

    await expect(
      getProxyConfigForBackend.handler(ctx as any, {
        serviceKey: "wrong",
        userId: "user_123",
      }),
    ).rejects.toThrow("Invalid service key");
    expect(mockReadObjectByName).not.toHaveBeenCalled();

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

  it("returns no runtime config when the Vault object is disabled", async () => {
    const { getProxyConfigForBackend } = await import("../proxyConfigActions");
    mockReadObjectByName.mockResolvedValue(vaultObject({ enabled: false }));
    const ctx = createCtx();

    await expect(
      getProxyConfigForBackend.handler(ctx as any, {
        serviceKey: "service_key",
        userId: "user_123",
      }),
    ).resolves.toBeNull();
  });

  it("deletes the versioned Vault object and treats a missing object as removed", async () => {
    const { deleteProxyConfig } = await import("../proxyConfigActions");
    const ctx = createCtx();
    mockReadObjectByName.mockResolvedValueOnce(vaultObject());

    await expect(deleteProxyConfig.handler(ctx as any, {})).resolves.toBeNull();
    expect(mockDeleteObject).toHaveBeenCalledWith({
      id: "secret_proxy_123",
      versionCheck: "version_1",
    });

    mockReadObjectByName.mockRejectedValueOnce(missingVaultObjectError());
    await expect(deleteProxyConfig.handler(ctx as any, {})).resolves.toBeNull();
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a Vault object has an invalid payload", async () => {
    const { getProxyConfigForBackend } = await import("../proxyConfigActions");
    mockReadObjectByName.mockResolvedValue({
      ...vaultObject(),
      value: JSON.stringify({ schemaVersion: 1, enabled: true }),
    });
    const ctx = createCtx();

    await expect(
      getProxyConfigForBackend.handler(ctx as any, {
        serviceKey: "service_key",
        userId: "user_123",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "PROXY_CONFIG_UNAVAILABLE" }),
    });
  });
});
