import "server-only";
import { createHmac } from "node:crypto";
import { abuseEvidenceKeyring } from "./evidence-crypto";
export { encryptAbuseEvidence, decryptAbuseEvidence } from "./evidence-crypto";

export function abuseIntakeEnabled(): boolean {
  if (process.env.ABUSE_INTAKE_ENABLED !== "true") return false;
  try {
    abuseEvidenceKeyring();
    return true;
  } catch {
    return false;
  }
}

export function abuseFingerprint(purpose: string, value: string): string {
  const config = abuseEvidenceKeyring();
  return createHmac("sha256", Buffer.from(config.keys[config.active], "hex"))
    .update(`${purpose}\0${value}`)
    .digest("hex");
}

/** Retained keys preserve retry identity and limiter continuity during rotation. */
export function abuseFingerprints(purpose: string, value: string): string[] {
  const config = abuseEvidenceKeyring();
  return [
    config.active,
    ...Object.keys(config.keys).filter((id) => id !== config.active),
  ].map((id) =>
    createHmac("sha256", Buffer.from(config.keys[id], "hex"))
      .update(`${purpose}\0${value}`)
      .digest("hex"),
  );
}
