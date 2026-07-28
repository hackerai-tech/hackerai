import type { AuthConfig } from "convex/server";

const clientId = process.env.WORKOS_CLIENT_ID ?? "";
const authOrigin = "https://auth.hackerai.co";

const authConfig = {
  providers: clientId
    ? [
        {
          type: "customJwt" as const,
          issuer: `${authOrigin}/user_management/${clientId}`,
          algorithm: "RS256" as const,
          jwks: `${authOrigin}/sso/jwks/${clientId}`,
        },
      ]
    : [],
} satisfies AuthConfig;

export default authConfig;
