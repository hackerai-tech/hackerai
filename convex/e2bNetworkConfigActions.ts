"use node";

import { isIP } from "node:net";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { validateServiceKey } from "./lib/utils";
import { hasPaidEntitlement } from "../lib/auth/entitlements";

const MAX_DESTINATIONS = 50;
const MAX_DESTINATION_LENGTH = 253;
const MIGRATION_LEASE_DURATION_MS = 10 * 60 * 1000;

const inboundModeValidator = v.union(
  v.literal("public"),
  v.literal("token_required"),
);
const outboundModeValidator = v.union(
  v.literal("unrestricted"),
  v.literal("allow_only"),
  v.literal("block_list"),
);
const subscriptionValidator = v.union(
  v.literal("pro"),
  v.literal("pro-plus"),
  v.literal("ultra"),
  v.literal("team"),
);
const configValidator = v.object({
  inboundMode: inboundModeValidator,
  outboundMode: outboundModeValidator,
  destinations: v.array(v.string()),
  updatedAt: v.number(),
});

type OutboundMode = "unrestricted" | "allow_only" | "block_list";
type InboundMode = "public" | "token_required";
type StoredNetworkConfig = {
  inbound_mode: InboundMode;
  outbound_mode: OutboundMode;
  destinations: string[];
  updated_at: number;
};
type PublicNetworkConfig = {
  inboundMode: InboundMode;
  outboundMode: OutboundMode;
  destinations: string[];
  updatedAt: number;
};

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
    (value): value is string => typeof value === "string",
  );
}

function requirePaidAccess(identity: unknown): void {
  if (!hasPaidEntitlement(getIdentityEntitlements(identity))) {
    throw new ConvexError({
      code: "PAID_PLAN_REQUIRED",
      message: "A paid Cloud Agent plan is required",
    });
  }
}

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_NETWORK_CONFIG", message });
}

function normalizeDomain(value: string): string | null {
  const wildcard = value.startsWith("*.");
  const hostname = wildcard ? value.slice(2) : value;
  if (
    !hostname ||
    hostname.length > MAX_DESTINATION_LENGTH ||
    hostname.includes("..") ||
    /^\d+(?:\.\d+){3}$/.test(hostname) ||
    !hostname.includes(".")
  ) {
    return null;
  }
  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return wildcard ? `*.${hostname}` : hostname;
}

function normalizeDestination(value: string, mode: OutboundMode): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.length > MAX_DESTINATION_LENGTH ||
    /\s|:\/\/|[?#@]/.test(normalized)
  ) {
    invalid(
      "Enter domains, IP addresses, or CIDR blocks without ports or URLs",
    );
  }

  const slash = normalized.indexOf("/");
  const address = slash === -1 ? normalized : normalized.slice(0, slash);
  const prefix = slash === -1 ? undefined : normalized.slice(slash + 1);
  if (slash !== -1 && normalized.indexOf("/", slash + 1) !== -1) {
    invalid(`Invalid CIDR block: ${value}`);
  }

  const ipVersion = isIP(address);
  if (ipVersion !== 0) {
    if (prefix !== undefined) {
      const prefixNumber = Number(prefix);
      const maxPrefix = ipVersion === 4 ? 32 : 128;
      if (
        prefix === "" ||
        !Number.isInteger(prefixNumber) ||
        prefixNumber < 0 ||
        prefixNumber > maxPrefix
      ) {
        invalid(`Invalid CIDR block: ${value}`);
      }
      return `${address}/${prefixNumber}`;
    }
    return address;
  }

  if (prefix !== undefined) invalid(`Invalid CIDR block: ${value}`);
  const domain = normalizeDomain(normalized);
  if (!domain) invalid(`Invalid domain or IP address: ${value}`);
  if (mode === "block_list") {
    invalid(
      "E2B deny lists support IP addresses and CIDR blocks, but not domains",
    );
  }
  return domain;
}

function normalizeDestinations(values: string[], mode: OutboundMode): string[] {
  if (mode === "unrestricted") return [];
  if (values.length > MAX_DESTINATIONS) {
    invalid(`Use at most ${MAX_DESTINATIONS} destinations`);
  }
  const normalized = Array.from(
    new Set(values.map((value) => normalizeDestination(value, mode))),
  );
  if (normalized.length === 0) {
    invalid("Add at least one destination for this outbound mode");
  }
  return normalized;
}

function toPublicConfig(stored: StoredNetworkConfig): PublicNetworkConfig {
  return {
    inboundMode: stored.inbound_mode,
    outboundMode: stored.outbound_mode,
    destinations: stored.destinations,
    updatedAt: stored.updated_at,
  };
}

export const getE2BNetworkConfig = action({
  args: {},
  returns: v.union(v.null(), configValidator),
  handler: async (ctx): Promise<PublicNetworkConfig | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    requirePaidAccess(identity);
    const stored: StoredNetworkConfig | null = await ctx.runQuery(
      internal.e2bNetworkConfigs.getForUser,
      { userId: identity.subject },
    );
    return stored ? toPublicConfig(stored) : null;
  },
});

export const saveE2BNetworkConfig = action({
  args: {
    inboundMode: inboundModeValidator,
    outboundMode: outboundModeValidator,
    destinations: v.array(v.string()),
  },
  returns: configValidator,
  handler: async (ctx, args): Promise<PublicNetworkConfig> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    requirePaidAccess(identity);
    const destinations = normalizeDestinations(
      args.destinations,
      args.outboundMode,
    );
    const updatedAt = Date.now();
    await ctx.runMutation(internal.e2bNetworkConfigs.upsertForUser, {
      userId: identity.subject,
      inboundMode: args.inboundMode,
      outboundMode: args.outboundMode,
      destinations,
      updatedAt,
    });
    return { ...args, destinations, updatedAt };
  },
});

export const getE2BNetworkConfigForBackend = action({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    subscription: subscriptionValidator,
  },
  returns: v.union(v.null(), configValidator),
  handler: async (ctx, args): Promise<PublicNetworkConfig | null> => {
    validateServiceKey(args.serviceKey);
    const stored: StoredNetworkConfig | null = await ctx.runQuery(
      internal.e2bNetworkConfigs.getForUser,
      { userId: args.userId },
    );
    return stored ? toPublicConfig(stored) : null;
  },
});

export const acquireE2BNetworkMigrationLease = action({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    leaseId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    validateServiceKey(args.serviceKey);
    const now = Date.now();
    return ctx.runMutation(
      internal.e2bNetworkConfigs.tryAcquireMigrationLease,
      {
        userId: args.userId,
        leaseId: args.leaseId,
        now,
        expiresAt: now + MIGRATION_LEASE_DURATION_MS,
      },
    );
  },
});

export const releaseE2BNetworkMigrationLease = action({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    leaseId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    validateServiceKey(args.serviceKey);
    await ctx.runMutation(internal.e2bNetworkConfigs.releaseMigrationLease, {
      userId: args.userId,
      leaseId: args.leaseId,
    });
    return null;
  },
});
