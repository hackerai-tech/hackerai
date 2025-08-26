const clientId = process.env.WORKOS_CLIENT_ID;

const authConfig = {
  providers: [
    {
      type: "customJwt",
      issuer: `https://auth.hackerai.co/`,
      algorithm: "RS256",
      applicationID: clientId,
      jwks: `https://auth.hackerai.co/sso/jwks/${clientId}`,
    },
    {
      type: "customJwt",
      issuer: `https://auth.hackerai.co/user_management/${clientId}`,
      algorithm: "RS256",
      jwks: `https://auth.hackerai.co/sso/jwks/${clientId}`,
      applicationID: clientId,
    },
  ],
};

export default authConfig;
