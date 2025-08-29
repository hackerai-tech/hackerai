"use server";

import { refreshSession } from "@workos-inc/authkit-nextjs";

export async function refreshAuthkitSession() {
  const session = await refreshSession({ ensureSignedIn: true });
  return JSON.stringify(session);
}
