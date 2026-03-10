const clientId = process.env.WORKOS_CLIENT_ID ?? "";

const authConfig = {
  providers: clientId
    ? [
        {
          type: "customJwt" as const,
          issuer: `https://auth.hackerai.co/`,
          algorithm: "RS256" as const,
          applicationID: clientId,
          jwks: `https://auth.hackerai.co/sso/jwks/${clientId}`,
        },
        {
          type: "customJwt" as const,
          issuer: `https://auth.hackerai.co/user_management/${clientId}`,
          algorithm: "RS256" as const,
          jwks: `https://auth.hackerai.co/sso/jwks/${clientId}`,
          applicationID: clientId,
        },
      ]
    : [],
};

export default authConfig;
