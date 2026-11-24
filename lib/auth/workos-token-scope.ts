import { decodeJwt } from "jose";

/** The account, session and organization AuthKit has committed in this tab. */
export type WorkOSSessionScope = {
  userId: string;
  sessionId?: string | null;
  organizationId?: string | null;
};

/** Match a cached token to the current UI scope before Convex verifies its signature. */
export function tokenMatchesWorkOSSession(
  token: string,
  scope: WorkOSSessionScope,
): boolean {
  try {
    const claims = decodeJwt(token);
    return (
      claims.sub === scope.userId &&
      (!scope.sessionId || claims.sid === scope.sessionId) &&
      (claims.org_id ?? null) === (scope.organizationId ?? null)
    );
  } catch {
    return false;
  }
}
