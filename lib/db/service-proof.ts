import { convexToJson, type Value } from "convex/values";

// Never transport the reusable service credential in a Convex argument. Native
// validation runs before our handler and includes invalid arguments in errors.
const VERSION = "hmac1";
const MAX_AGE_MS = 60_000;
const CLOCK_SKEW_MS = 10_000;
const encoder = new TextEncoder();

export type ServiceScope = {
  deployment: string;
  name: string;
  type: "query" | "mutation" | "action";
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

// The verified Production custom domain and native deployment are one identity.
// Preview and local URLs remain distinct; never infer identity from a prod label.
const deploymentIdentity = (url: string): string => {
  const normalized = url.replace(/\/$/, "");
  return normalized === "https://convex.haiusercontent.com"
    ? "https://greedy-cod-889.convex.cloud"
    : normalized;
};

const payload = (
  scope: ServiceScope,
  args: Record<string, unknown>,
  issuedAt: number,
): Uint8Array<ArrayBuffer> => {
  const { serviceKey: _credential, ...parameters } = args;
  return encoder.encode(
    stableJson({
      version: VERSION,
      ...scope,
      deployment: deploymentIdentity(scope.deployment),
      issuedAt,
      args: convexToJson(parameters as Value),
    }),
  );
};

const importKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

export async function signServiceArgs(
  scope: ServiceScope,
  args: Record<string, unknown>,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (!("serviceKey" in args)) return args;
  const secret = args.serviceKey;
  if (
    typeof secret !== "string" ||
    !secret ||
    secret.startsWith(`${VERSION}.`)
  ) {
    throw new Error("Invalid service credential configuration");
  }
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret),
    payload(scope, args, now),
  );
  const hex = Array.from(new Uint8Array(signature), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return { ...args, serviceKey: `${VERSION}.${now}.${hex}` };
}

export async function verifyServiceArgs(
  scope: ServiceScope,
  args: Record<string, unknown>,
  secret: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!secret || typeof args.serviceKey !== "string") return false;
  const match = /^hmac1\.(\d{13})\.([a-f0-9]{64})$/.exec(args.serviceKey);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  if (now - issuedAt > MAX_AGE_MS || issuedAt - now > CLOCK_SKEW_MS)
    return false;
  const signature = Uint8Array.from(match[2].match(/../g)!, (byte) =>
    Number.parseInt(byte, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    signature,
    payload(scope, args, issuedAt),
  );
}
