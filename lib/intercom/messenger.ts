import "server-only";

import { SignJWT } from "jose";

export const INTERCOM_APP_ID = "wjc8uwt3";
export const INTERCOM_API_BASE = "https://api-iam.intercom.io";
export const INTERCOM_JWT_TTL_SECONDS = 5 * 60;

type IntercomUser = {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

export function getIntercomIdentityClaims(user: IntercomUser) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");

  return {
    user_id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(name ? { name } : {}),
  };
}

export type IntercomMessengerIdentity = {
  appId: string;
  apiBase: string;
  userId: string;
  userJwt: string;
};

/**
 * Creates the short-lived, server-signed identity used to boot Messenger.
 * Returning null keeps Intercom disabled until its server-only secret is set.
 */
export async function createIntercomMessengerIdentity(
  user: IntercomUser,
): Promise<IntercomMessengerIdentity | null> {
  const secret = process.env.INTERCOM_MESSENGER_SECRET?.trim();
  if (!secret) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const userJwt = await new SignJWT(getIntercomIdentityClaims(user))
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + INTERCOM_JWT_TTL_SECONDS)
    .sign(new TextEncoder().encode(secret));

  return {
    appId: INTERCOM_APP_ID,
    apiBase: INTERCOM_API_BASE,
    userId: user.id,
    userJwt,
  };
}
