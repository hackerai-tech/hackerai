import { readFile } from "node:fs/promises";
import {
  createHash,
  randomUUID,
  scrypt as derive,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { LOCAL_ENTITLEMENTS } from "./config";

const scrypt = promisify(derive);
export const SESSION_COOKIE = "hackerai-local-session";
const issuer = () => process.env.NEXT_PUBLIC_BASE_URL!;
const passwordVersion = () =>
  createHash("sha256")
    .update(process.env.LOCAL_AUTH_PASSWORD_HASH ?? "")
    .digest("hex");
const keyId = "hackerai-vps-1";
const key = async (name: "private" | "public") =>
  readFile(
    `${process.env.LOCAL_AUTH_KEY_DIR ?? "/run/local-auth"}/${name}.pem`,
    "utf8",
  );
export const localUserId = () =>
  process.env.LOCAL_AUTH_USER_ID ?? "user_vps_admin";

export async function checkPassword(
  email: string,
  password: string,
): Promise<boolean> {
  const [salt, expected] = (process.env.LOCAL_AUTH_PASSWORD_HASH ?? "").split(
    ":",
  );
  if (
    !salt ||
    !/^[0-9a-f]{128}$/.test(expected ?? "") ||
    password.length > 1024
  )
    return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return (
    timingSafeEqual(actual, Buffer.from(expected, "hex")) &&
    email.toLowerCase() === process.env.LOCAL_AUTH_EMAIL?.toLowerCase()
  );
}

export async function signSession(
  authTime = Math.floor(Date.now() / 1000),
  lifetime = "12h",
  sessionId: string = randomUUID(),
) {
  const privateKey = await importPKCS8(await key("private"), "RS256");
  return new SignJWT({
    email: process.env.LOCAL_AUTH_EMAIL,
    entitlements: LOCAL_ENTITLEMENTS,
    sid: sessionId,
    auth_time: authTime,
    password_version: passwordVersion(),
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setSubject(localUserId())
    .setIssuer(issuer())
    .setAudience("hackerai-vps")
    .setIssuedAt()
    .setExpirationTime(lifetime)
    .sign(privateKey);
}

export async function readSession(token: string | undefined) {
  if (!token) return null;
  const publicKey = await importSPKI(await key("public"), "RS256");
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: issuer(),
      audience: "hackerai-vps",
    });
    if (
      payload.password_version !== passwordVersion() ||
      payload.sub !== localUserId() ||
      typeof payload.auth_time !== "number" ||
      typeof payload.sid !== "string"
    )
      return null;
    const signedInAt = new Date(payload.auth_time * 1000).toISOString();
    return {
      user: {
        object: "user" as const,
        id: payload.sub,
        email: process.env.LOCAL_AUTH_EMAIL!,
        emailVerified: true,
        firstName: "Administrador",
        lastName: null,
        profilePictureUrl: null,
        locale: "pt-BR",
        metadata: {},
        lastSignInAt: signedInAt,
        createdAt: signedInAt,
        updatedAt: signedInAt,
        externalId: null,
      },
      sessionId: payload.sid,
      entitlements: LOCAL_ENTITLEMENTS,
      accessToken: token,
    };
  } catch {
    return null;
  }
}

export async function publicJwks() {
  const jwk = await exportJWK(await importSPKI(await key("public"), "RS256"));
  return { keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig" }] };
}
