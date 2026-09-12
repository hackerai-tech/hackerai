import { createHash } from "node:crypto";

/** Existing provider identity: changing this would orphan users' workspaces. */
export const miosaExternalUserId = (userId: string): string =>
  `hackerai-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;

/** A support label, never an authorization or workspace lookup key. */
export const miosaUserReference = (userId: string): string =>
  `hackerai-user-${miosaExternalUserId(userId).slice(9, 21)}`;

export function miosaIdentityMetadata(userId: string) {
  // NODE_ENV is also production in Preview workers; never infer from it.
  const selected = (process.env.TRIGGER_ENV ?? process.env.VERCEL_ENV ?? "")
    .trim()
    .toLowerCase();
  const environment = ["production", "preview", "development"].includes(
    selected,
  )
    ? selected
    : "unknown";
  return {
    userReference: miosaUserReference(userId),
    environment,
    identityVersion: "1",
  };
}

/** Accept existing provider names as well as the shorter support reference. */
export function matchesMiosaUserReference(userId: string, reference: string) {
  const externalId = miosaExternalUserId(userId);
  return (
    reference === miosaUserReference(userId) ||
    reference === externalId ||
    reference === `${externalId}-v2`
  );
}
