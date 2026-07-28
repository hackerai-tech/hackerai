const clientId = process.env.WORKOS_CLIENT_ID ?? "";
// Allow overriding the auth domain for self-hosted/dev environments.
// Defaults to api.workos.com (standard WorkOS issuer).
// Set WORKOS_AUTH_DOMAIN=auth.hackerai.co for the production deployment.
const authDomain = process.env.WORKOS_AUTH_DOMAIN ?? "api.workos.com";

const authConfig = {
  providers: clientId
    ? [
        {
          type: "customJwt" as const,
          issuer: `https://${authDomain}/user_management/${clientId}`,
          algorithm: "RS256" as const,
          jwks: `https://${authDomain}/sso/jwks/${clientId}`,
        },
      ]
    : [],
};

export default authConfig;
