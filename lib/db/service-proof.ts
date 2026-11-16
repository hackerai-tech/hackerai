import { convexToJson, type Value } from "convex/values";

// Never transport the reusable service credential in a Convex argument. Native
// validation runs before our handler and includes invalid arguments in errors.
const VERSION = "hmac1";
const MAX_AGE_MS = 60_000;
const CLOCK_SKEW_MS = 10_000;
// Anchored without the m flag, so any match is exactly PROOF_LENGTH characters.
const PROOF_PATTERN = /^hmac1\.(\d{13})\.([a-f0-9]{64})$/;
const PROOF_LENGTH = 84;
const encoder = new TextEncoder();

const isExpired = (issuedAt: number, now: number) =>
  now - issuedAt > MAX_AGE_MS;
const isFuture = (issuedAt: number, now: number) =>
  issuedAt - now > CLOCK_SKEW_MS;

export type ServiceScope = {
  deployment: string;
  name: string;
  type: "query" | "mutation" | "action";
};

/**
 * What the caller-supplied credential looks like at rejection time. This is an
 * observation of public input, not the predicate that rejected it: it never
 * depends on the secret, its presence, the scope or the other arguments, so it
 * cannot reveal key configuration or whether a raw credential is correct.
 * `verification_failed` covers every well-formed, fresh proof that was
 * rejected for any reason.
 */
export type ServiceProofObservation =
  | "credential_not_string"
  | "proof_malformed"
  | "proof_expired"
  | "proof_future"
  | "verification_failed";

export type ServiceProofRejectObserver = (
  observation: ServiceProofObservation,
) => void;

// The length gate bounds diagnostic regex work on arbitrary input, including
// when verification short-circuited before parsing (no secret configured).
const observePublicProof = (
  proof: string,
  now: number,
): ServiceProofObservation => {
  if (proof.length !== PROOF_LENGTH) return "proof_malformed";
  const match = PROOF_PATTERN.exec(proof);
  if (!match) return "proof_malformed";
  const issuedAt = Number(match[1]);
  if (isExpired(issuedAt, now)) return "proof_expired";
  if (isFuture(issuedAt, now)) return "proof_future";
  return "verification_failed";
};

// Every verification false return goes through here. Without an observer it
// does no extra work. Diagnostic failures never change the false result.
const rejected = (
  args: Record<string, unknown>,
  now: number,
  onReject: ServiceProofRejectObserver | undefined,
): false => {
  if (!onReject) return false;
  let observation: ServiceProofObservation = "verification_failed";
  try {
    const credential = args.serviceKey;
    observation =
      typeof credential === "string"
        ? observePublicProof(credential, now)
        : "credential_not_string";
  } catch {
    // Keep the generic observation; never report the thrown value.
  }
  try {
    onReject(observation);
  } catch {
    // Observation is best-effort and must not affect authorization.
  }
  return false;
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
  onReject?: ServiceProofRejectObserver,
): Promise<boolean> {
  if (!secret || typeof args.serviceKey !== "string")
    return rejected(args, now, onReject);
  const match = PROOF_PATTERN.exec(args.serviceKey);
  if (!match) return rejected(args, now, onReject);
  const issuedAt = Number(match[1]);
  if (isExpired(issuedAt, now) || isFuture(issuedAt, now))
    return rejected(args, now, onReject);
  const signature = Uint8Array.from(match[2].match(/../g)!, (byte) =>
    Number.parseInt(byte, 16),
  );
  // Cryptographic and payload exceptions propagate unchanged and unobserved.
  const verified = await crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    signature,
    payload(scope, args, issuedAt),
  );
  return verified || rejected(args, now, onReject);
}
