const clientId = process.env.WORKOS_CLIENT_ID ?? "";

const authConfig = {
  providers: clientId
    ? [
        {
          type: "customJwt" as const,
          issuer: `https://auth.zhacker.ai/`,
          algorithm: "RS256" as const,
          applicationID: clientId,
          jwks: `https://auth.zhacker.ai/sso/jwks/${clientId}`,
        },
        {
          type: "customJwt" as const,
          issuer: `https://auth.zhacker.ai/user_management/${clientId}`,
          algorithm: "RS256" as const,
          jwks: `https://auth.zhacker.ai/sso/jwks/${clientId}`,
          applicationID: clientId,
        },
      ]
    : [],
};

export default authConfig;
