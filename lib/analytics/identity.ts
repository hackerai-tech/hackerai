import { v5 as uuidv5 } from "uuid";
import type { FirstTouchAttribution } from "@/lib/analytics/acquisition";

export const POSTHOG_IDENTITY_SIGNATURE_STORAGE_KEY =
  "hackerai:analytics:identity-signature:v1";

export function createPostHogIdentitySignature({
  userId,
  email,
  name,
  subscription,
  firstTouchAttribution,
}: {
  userId: string;
  email?: string | null;
  name?: string | null;
  subscription: string;
  firstTouchAttribution?: FirstTouchAttribution | null;
}) {
  return uuidv5(
    JSON.stringify([
      userId,
      email ?? null,
      name ?? null,
      subscription,
      firstTouchAttribution ?? null,
    ]),
    uuidv5.URL,
  );
}
