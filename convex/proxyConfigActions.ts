"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { isIP } from "node:net";
import { validateServiceKey } from "./lib/utils";
import {
  decryptProxyConfig,
  encryptProxyConfig,
  type StoredProxyConfig,
} from "./lib/proxyConfigCrypto";

const MAX_HOST_LENGTH = 253;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_BYPASS_HOSTS = 25;
const MAX_BYPASS_HOST_LENGTH = 253;

type ProxyProtocol = "http" | "socks5";
type EncryptedProxyConfig = {
  enabled: boolean;
  protocol: ProxyProtocol;
  encryptedConfig: string;
  updatedAt: number;
};
type PublicProxyConfig = Omit<StoredProxyConfig, "password"> & {
  enabled: boolean;
  protocol: ProxyProtocol;
  hasPassword: boolean;
  updatedAt: number;
};
type RuntimeProxyConfig = StoredProxyConfig & {
  protocol: ProxyProtocol;
  updatedAt: number;
};

const proxyProtocolValidator = v.union(v.literal("http"), v.literal("socks5"));

const publicProxyConfigValidator = v.object({
  enabled: v.boolean(),
  protocol: proxyProtocolValidator,
  host: v.string(),
  port: v.number(),
  username: v.optional(v.string()),
  hasPassword: v.boolean(),
  proxyDns: v.boolean(),
  bypassHosts: v.array(v.string()),
  updatedAt: v.number(),
});

const runtimeProxyConfigValidator = v.object({
  protocol: proxyProtocolValidator,
  host: v.string(),
  port: v.number(),
  username: v.optional(v.string()),
  password: v.optional(v.string()),
  proxyDns: v.boolean(),
  bypassHosts: v.array(v.string()),
  updatedAt: v.number(),
});

function getEncryptionKey(): string {
  const key = process.env.USER_PROXY_CONFIG_ENCRYPTION_KEY;
  if (!key) {
    throw new ConvexError({
      code: "PROXY_CONFIG_UNAVAILABLE",
      message: "Proxy configuration encryption is not configured",
    });
  }
  return key;
}

function normalizeHost(value: string): string {
  const host = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const isIpAddress = isIP(host) !== 0;
  const isValidHostname =
    host.length > 0 &&
    host.length <= MAX_HOST_LENGTH &&
    !host.includes("..") &&
    /^[a-z0-9.-]+$/i.test(host) &&
    host.split(".").every((label) => {
      return (
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-")
      );
    });

  if (!isIpAddress && !isValidHostname) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: "Enter a valid proxy hostname or IP address",
    });
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: "The proxy must be reachable from the cloud sandbox",
    });
  }
  return host;
}

function normalizeBypassHosts(values: string[]): string[] {
  if (values.length > MAX_BYPASS_HOSTS) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: `Use at most ${MAX_BYPASS_HOSTS} proxy bypass entries`,
    });
  }

  const normalized = values.map((value) => value.trim().toLowerCase());
  for (const value of normalized) {
    if (
      !value ||
      value.length > MAX_BYPASS_HOST_LENGTH ||
      /[\s/@:#?]/.test(value) ||
      !/^(\*\.)?[a-z0-9.-]+$/i.test(value)
    ) {
      throw new ConvexError({
        code: "INVALID_PROXY_CONFIG",
        message: "Enter valid hostnames in the proxy bypass list",
      });
    }
  }

  return Array.from(new Set(normalized));
}

function normalizeStoredConfig(args: {
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxyDns: boolean;
  bypassHosts: string[];
}): StoredProxyConfig {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: "Proxy port must be between 1 and 65535",
    });
  }

  const username = args.username?.trim() || undefined;
  if (username && username.length > MAX_USERNAME_LENGTH) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: "Proxy username is too long",
    });
  }
  if (
    args.password !== undefined &&
    args.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: "Proxy password is too long",
    });
  }
  if (args.password && !username) {
    throw new ConvexError({
      code: "INVALID_PROXY_CONFIG",
      message: "Enter a proxy username when using a password",
    });
  }

  return {
    host: normalizeHost(args.host),
    port: args.port,
    username,
    ...(args.password !== undefined ? { password: args.password } : {}),
    proxyDns: args.proxyDns,
    bypassHosts: normalizeBypassHosts(args.bypassHosts),
  };
}

function toPublicConfig(
  stored: StoredProxyConfig,
  metadata: {
    enabled: boolean;
    protocol: ProxyProtocol;
    updatedAt: number;
  },
): PublicProxyConfig {
  return {
    enabled: metadata.enabled,
    protocol: metadata.protocol,
    host: stored.host,
    port: stored.port,
    ...(stored.username ? { username: stored.username } : {}),
    hasPassword: stored.password !== undefined,
    proxyDns: stored.proxyDns,
    bypassHosts: stored.bypassHosts,
    updatedAt: metadata.updatedAt,
  };
}

export const getProxyConfig = action({
  args: {},
  returns: v.union(v.null(), publicProxyConfigValidator),
  handler: async (ctx): Promise<PublicProxyConfig | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }

    const encrypted: EncryptedProxyConfig | null = await ctx.runQuery(
      internal.proxyConfigs.getEncryptedForUser,
      { userId: identity.subject },
    );
    if (!encrypted) return null;

    const stored = decryptProxyConfig(
      encrypted.encryptedConfig,
      identity.subject,
      getEncryptionKey(),
    );
    return toPublicConfig(stored, encrypted);
  },
});

export const saveProxyConfig = action({
  args: {
    enabled: v.boolean(),
    protocol: proxyProtocolValidator,
    host: v.string(),
    port: v.number(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    clearPassword: v.optional(v.boolean()),
    proxyDns: v.boolean(),
    bypassHosts: v.array(v.string()),
  },
  returns: publicProxyConfigValidator,
  handler: async (ctx, args): Promise<PublicProxyConfig> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }

    const encryptionKey = getEncryptionKey();
    const existing: EncryptedProxyConfig | null = await ctx.runQuery(
      internal.proxyConfigs.getEncryptedForUser,
      { userId: identity.subject },
    );
    const existingStored = existing
      ? decryptProxyConfig(
          existing.encryptedConfig,
          identity.subject,
          encryptionKey,
        )
      : null;
    const password = args.clearPassword
      ? undefined
      : args.password !== undefined
        ? args.password
        : existingStored?.password;
    const stored = normalizeStoredConfig({
      host: args.host,
      port: args.port,
      username: args.username,
      ...(password !== undefined ? { password } : {}),
      proxyDns: args.proxyDns,
      bypassHosts: args.bypassHosts,
    });
    const updatedAt = Date.now();

    await ctx.runMutation(internal.proxyConfigs.upsertEncryptedForUser, {
      userId: identity.subject,
      enabled: args.enabled,
      protocol: args.protocol,
      encryptedConfig: encryptProxyConfig(
        stored,
        identity.subject,
        encryptionKey,
      ),
      updatedAt,
    });

    return toPublicConfig(stored, {
      enabled: args.enabled,
      protocol: args.protocol,
      updatedAt,
    });
  },
});

export const deleteProxyConfig = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    await ctx.runMutation(internal.proxyConfigs.deleteForUser, {
      userId: identity.subject,
    });
    return null;
  },
});

export const getProxyConfigForBackend = action({
  args: { serviceKey: v.string(), userId: v.string() },
  returns: v.union(v.null(), runtimeProxyConfigValidator),
  handler: async (ctx, args): Promise<RuntimeProxyConfig | null> => {
    validateServiceKey(args.serviceKey);
    const encrypted: EncryptedProxyConfig | null = await ctx.runQuery(
      internal.proxyConfigs.getEncryptedForUser,
      { userId: args.userId },
    );
    if (!encrypted?.enabled) return null;

    const stored = decryptProxyConfig(
      encrypted.encryptedConfig,
      args.userId,
      getEncryptionKey(),
    );
    return {
      protocol: encrypted.protocol,
      ...stored,
      updatedAt: encrypted.updatedAt,
    };
  },
});
