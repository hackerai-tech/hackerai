"use node";

import { WorkOS } from "@workos-inc/node";
import { ConvexError, v } from "convex/values";
import { isIP } from "node:net";

import { internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";
import { validateServiceKey } from "./lib/utils";
import { hasPaidEntitlement } from "../lib/auth/entitlements";
import {
  deleteProxyConfigVaultObject,
  getProxyConfigVaultObjectName,
  readProxyConfigVaultObject,
} from "../lib/workos/proxy-vault";

const MAX_HOST_LENGTH = 253;
const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_BYPASS_HOSTS = 25;
const MAX_BYPASS_HOST_LENGTH = 253;
const PROXY_CONFIG_SCHEMA_VERSION = 1;

type ProxyProtocol = "http" | "socks5";
type StoredProxyConfig = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  proxyDns: boolean;
  bypassHosts: string[];
};
type VaultProxyConfig = StoredProxyConfig & {
  schemaVersion: typeof PROXY_CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  protocol: ProxyProtocol;
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

let workosInstance: WorkOS | null = null;

const proxyProtocolValidator = v.union(v.literal("http"), v.literal("socks5"));

function getWorkOS(): WorkOS {
  if (!workosInstance) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) {
      throw new ConvexError({
        code: "PROXY_CONFIG_UNAVAILABLE",
        message: "WorkOS Vault is not configured",
      });
    }
    workosInstance = new WorkOS(apiKey, {
      clientId: process.env.WORKOS_CLIENT_ID,
    });
  }
  return workosInstance;
}

function getIdentityEntitlements(identity: unknown): string[] {
  if (
    !identity ||
    typeof identity !== "object" ||
    !("entitlements" in identity) ||
    !Array.isArray(identity.entitlements)
  ) {
    return [];
  }

  return identity.entitlements.filter(
    (entitlement): entitlement is string => typeof entitlement === "string",
  );
}

function requirePaidProxyAccess(identity: unknown): void {
  if (!hasPaidEntitlement(getIdentityEntitlements(identity))) {
    throw new ConvexError({
      code: "PAID_PLAN_REQUIRED",
      message: "A paid Cloud Agent plan is required",
    });
  }
}

function accountDeletionInProgress(): ConvexError<{
  code: string;
  message: string;
}> {
  return new ConvexError({
    code: "ACCOUNT_DELETION_IN_PROGRESS",
    message:
      "Proxy settings cannot be changed while account deletion is in progress",
  });
}

async function isAccountDeletionFenced(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: string,
): Promise<boolean> {
  return ctx.runQuery(internal.accountDeletionFences.isSet, { userId });
}

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

function invalidStoredConfig(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "PROXY_CONFIG_UNAVAILABLE",
    message: "The stored proxy configuration is invalid",
  });
}

function parseVaultProxyConfig(value: string | undefined): VaultProxyConfig {
  if (!value) throw invalidStoredConfig();

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== PROXY_CONFIG_SCHEMA_VERSION ||
      typeof parsed.enabled !== "boolean" ||
      (parsed.protocol !== "http" && parsed.protocol !== "socks5") ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      (parsed.username !== undefined && typeof parsed.username !== "string") ||
      (parsed.password !== undefined && typeof parsed.password !== "string") ||
      typeof parsed.proxyDns !== "boolean" ||
      !Array.isArray(parsed.bypassHosts) ||
      !parsed.bypassHosts.every((host) => typeof host === "string") ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      throw invalidStoredConfig();
    }

    return {
      schemaVersion: PROXY_CONFIG_SCHEMA_VERSION,
      enabled: parsed.enabled,
      protocol: parsed.protocol,
      ...normalizeStoredConfig({
        host: parsed.host,
        port: parsed.port,
        ...(parsed.username !== undefined ? { username: parsed.username } : {}),
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
        proxyDns: parsed.proxyDns,
        bypassHosts: parsed.bypassHosts,
      }),
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === "object" &&
      error.data !== null &&
      "code" in error.data &&
      error.data.code === "PROXY_CONFIG_UNAVAILABLE"
    ) {
      throw error;
    }
    throw invalidStoredConfig();
  }
}

async function readVaultProxyConfig(userId: string) {
  const object = await readProxyConfigVaultObject(getWorkOS(), userId);
  if (!object) return null;
  return { object, config: parseVaultProxyConfig(object.value) };
}

function toPublicConfig(config: VaultProxyConfig): PublicProxyConfig {
  return {
    enabled: config.enabled,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    ...(config.username ? { username: config.username } : {}),
    hasPassword: config.password !== undefined,
    proxyDns: config.proxyDns,
    bypassHosts: config.bypassHosts,
    updatedAt: config.updatedAt,
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

    const stored = await readVaultProxyConfig(identity.subject);
    return stored ? toPublicConfig(stored.config) : null;
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
    requirePaidProxyAccess(identity);

    if (await isAccountDeletionFenced(ctx, identity.subject)) {
      throw accountDeletionInProgress();
    }

    const existing = await readVaultProxyConfig(identity.subject);
    const password = args.clearPassword
      ? undefined
      : args.password !== undefined
        ? args.password
        : existing?.config.password;
    const config: VaultProxyConfig = {
      schemaVersion: PROXY_CONFIG_SCHEMA_VERSION,
      enabled: args.enabled,
      protocol: args.protocol,
      ...normalizeStoredConfig({
        host: args.host,
        port: args.port,
        username: args.username,
        ...(password !== undefined ? { password } : {}),
        proxyDns: args.proxyDns,
        bypassHosts: args.bypassHosts,
      }),
      updatedAt: Date.now(),
    };
    const value = JSON.stringify(config);
    const workos = getWorkOS();

    if (await isAccountDeletionFenced(ctx, identity.subject)) {
      throw accountDeletionInProgress();
    }

    if (existing) {
      await workos.vault.updateObject({
        id: existing.object.id,
        value,
        ...(existing.object.metadata.versionId
          ? { versionCheck: existing.object.metadata.versionId }
          : {}),
      });
    } else {
      await workos.vault.createObject({
        name: getProxyConfigVaultObjectName(identity.subject),
        value,
        context: {
          user_id: identity.subject,
          data_type: "agent_proxy",
        },
      });
    }

    if (await isAccountDeletionFenced(ctx, identity.subject)) {
      await deleteProxyConfigVaultObject(workos, identity.subject);
      throw accountDeletionInProgress();
    }

    return toPublicConfig(config);
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
    await deleteProxyConfigVaultObject(getWorkOS(), identity.subject);
    return null;
  },
});

export const getProxyConfigForBackend = action({
  args: { serviceKey: v.string(), userId: v.string() },
  returns: v.union(v.null(), runtimeProxyConfigValidator),
  handler: async (ctx, args): Promise<RuntimeProxyConfig | null> => {
    validateServiceKey(args.serviceKey);
    const stored = await readVaultProxyConfig(args.userId);
    if (!stored?.config.enabled) return null;

    return {
      protocol: stored.config.protocol,
      host: stored.config.host,
      port: stored.config.port,
      ...(stored.config.username ? { username: stored.config.username } : {}),
      ...(stored.config.password !== undefined
        ? { password: stored.config.password }
        : {}),
      proxyDns: stored.config.proxyDns,
      bypassHosts: stored.config.bypassHosts,
      updatedAt: stored.config.updatedAt,
    };
  },
});
