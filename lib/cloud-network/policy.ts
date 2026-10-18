import { z } from "zod";
import { normalizeTarget } from "../engagement-scope/policy";

export const networkPolicySchema = z
  .object({
    mode: z.enum(["unrestricted", "restricted", "offline"]),
    allow: z.array(z.string().max(253)).max(100),
  })
  .strict();
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  mode: "unrestricted",
  allow: [],
};

function networkHost(value: string): string {
  try {
    return normalizeTarget(value);
  } catch {
    throw new Error(
      "Use a valid hostname, wildcard, IPv4 address, or IPv4 CIDR. URLs and ports are not supported.",
    );
  }
}
export function normalizeNetworkPolicy(input: unknown): NetworkPolicy {
  const parsed = networkPolicySchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Choose a network mode and use at most 100 destinations of up to 253 characters each.",
    );
  const policy = parsed.data;
  const allow = [
    ...new Set(
      policy.allow.map((entry) => {
        const value = entry.trim();
        // CIDRs here are IPv4 only. Never resolve a hostname into a shared-IP grant.
        if (value.includes("/")) {
          const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(value);
          if (
            !match ||
            Number(match[2]) > 32 ||
            String(Number(match[2])) !== match[2]
          )
            throw new Error(
              "Use a hostname, wildcard, IPv4 address, or IPv4 CIDR. URLs and ports are not supported.",
            );
          if (networkHost(match[1]) !== match[1])
            throw new Error("Use a canonical IPv4 address.");
          return value;
        }
        const host = networkHost(value);
        if (host.includes(":") || host.startsWith("["))
          throw new Error("IPv6 is not supported by this setting.");
        return host;
      }),
    ),
  ].sort();
  if (policy.mode === "restricted" && !allow.length)
    throw new Error("Add an allowed destination or choose No internet.");
  return {
    mode: policy.mode,
    allow: policy.mode === "restricted" ? allow : [],
  };
}

export function e2bNetwork(policy: NetworkPolicy) {
  return {
    allowOut: policy.mode === "restricted" ? policy.allow : [],
    denyOut: policy.mode === "unrestricted" ? [] : ["0.0.0.0/0"],
  };
}

export type NetworkSettings = {
  policy: NetworkPolicy;
  revision: number;
  status: "ready" | "applying" | "failed";
};
