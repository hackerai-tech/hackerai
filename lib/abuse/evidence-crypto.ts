import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const keyringSchema = z.object({
  active: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  keys: z.record(
    z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    z.string().regex(/^[a-fA-F0-9]{64}$/),
  ),
});

export function abuseEvidenceKeyring() {
  try {
    const result = keyringSchema.parse(
      JSON.parse(process.env.ABUSE_EVIDENCE_KEYS ?? ""),
    );
    if (!result.keys[result.active] || Object.keys(result.keys).length > 5)
      throw new Error();
    return result;
  } catch {
    throw new Error("Abuse evidence storage is unavailable");
  }
}

/** Encryption happens before native RPC, whose validation errors may echo arguments. */
export function encryptAbuseEvidence(
  reference: string,
  value: unknown,
): string {
  const config = abuseEvidenceKeyring();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.keys[config.active], "hex"),
    nonce,
  );
  cipher.setAAD(Buffer.from(`abuse:v1:${reference}`));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    config.active,
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptAbuseEvidence(
  reference: string,
  envelope: string,
): unknown {
  try {
    const [version, keyId, iv, tag, ciphertext, extra] = envelope.split(".");
    const config = abuseEvidenceKeyring();
    if (version !== "v1" || extra || !config.keys[keyId]) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.keys[keyId], "hex"),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`abuse:v1:${reference}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw new Error("Abuse evidence could not be read");
  }
}
