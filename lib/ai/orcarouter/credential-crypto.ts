import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Users' OrcaRouter keys are stored in Convex only as AES-256-GCM ciphertext.
 * The encryption key lives in the Next.js server environment, so a database
 * read alone does not reveal a usable credential. A caller-supplied context
 * (the user ID for stored keys) is bound as additional authenticated data so
 * a ciphertext cannot be replayed on another account or for another purpose.
 */

const VERSION = "v1";
const IV_BYTES = 12;

export const ORCAROUTER_CREDENTIALS_KEY_ENV = "ORCAROUTER_CREDENTIALS_KEY";

const loadKey = (env: Record<string, string | undefined>): Buffer | null => {
  const raw = env[ORCAROUTER_CREDENTIALS_KEY_ENV]?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
};

/** Connecting OrcaRouter is available only when the deployment has a key. */
export const isOrcaRouterCredentialStorageConfigured = (
  env: Record<string, string | undefined> = process.env,
) => loadKey(env) !== null;

const requireKey = (env: Record<string, string | undefined>) => {
  const key = loadKey(env);
  if (!key) {
    throw new Error(
      `${ORCAROUTER_CREDENTIALS_KEY_ENV} must be a base64-encoded 32-byte key`,
    );
  }
  return key;
};

export function sealOrcaRouterSecret(
  plaintext: string,
  context: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", requireKey(env), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function openOrcaRouterSecret(
  sealed: string,
  context: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const [version, iv, tag, ciphertext] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Unsupported sealed OrcaRouter secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    requireKey(env),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
