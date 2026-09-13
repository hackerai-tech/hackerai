import type { AuthConfig } from "convex/server";

const clientId = process.env.WORKOS_CLIENT_ID ?? "";

function resolveAuthOrigin(authDomain: string | undefined): string {
  const configuredDomain = authDomain?.trim();
  const errorMessage =
    "WORKOS_AUTH_DOMAIN must be a hostname or HTTPS origin without a path";

  if (!configuredDomain) {
    throw new Error(errorMessage);
  }

  let authOrigin: URL;
  try {
    authOrigin = new URL(
      configuredDomain.includes("://")
        ? configuredDomain
        : `https://${configuredDomain}`,
    );
  } catch {
    throw new Error(errorMessage);
  }

  if (
    authOrigin.protocol !== "https:" ||
    authOrigin.username ||
    authOrigin.password ||
    authOrigin.port ||
    !authOrigin.hostname ||
    !/^\/+$/.test(authOrigin.pathname) ||
    authOrigin.search ||
    authOrigin.hash
  ) {
    throw new Error(errorMessage);
  }

  return authOrigin.origin;
}

function createWorkOSProvider(
  clientId: string,
  authDomain: string | undefined,
) {
  const authOrigin = resolveAuthOrigin(authDomain);
  return {
    type: "customJwt" as const,
    issuer: `${authOrigin}/user_management/${clientId}`,
    algorithm: "RS256" as const,
    jwks: `${authOrigin}/sso/jwks/${clientId}`,
  };
}

const authConfig = {
  providers: clientId
    ? [createWorkOSProvider(clientId, process.env.WORKOS_AUTH_DOMAIN)]
    : [],
} satisfies AuthConfig;

export default authConfig;
