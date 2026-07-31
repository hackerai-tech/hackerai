import { v5 as uuidv5 } from "uuid";

export const POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY =
  "hackerai:analytics:identity-signature:v1";

export function createPostHogIdentitySignature({
  userId,
  email,
  name,
  subscription,
}: {
  userId: string;
  email?: string | null;
  name?: string | null;
  subscription: string;
}) {
  return uuidv5(
    JSON.stringify([userId, email ?? null, name ?? null, subscription]),
    uuidv5.URL,
  );
}
