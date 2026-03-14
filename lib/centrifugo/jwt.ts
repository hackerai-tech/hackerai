import { createHmac } from "crypto";

interface CentrifugoJwtHeader {
  typ: "JWT";
  alg: "HS256";
}

interface CentrifugoJwtPayload {
  sub: string;
  exp: number;
}

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function generateCentrifugoToken(
  userId: string,
  expSeconds: number,
): string {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;

  if (!secret) {
    throw new Error("CENTRIFUGO_TOKEN_SECRET environment variable is not set");
  }

  const header: CentrifugoJwtHeader = { typ: "JWT", alg: "HS256" };

  const payload: CentrifugoJwtPayload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + expSeconds,
  };

  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload)));

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlEncode(
    createHmac("sha256", secret).update(signingInput).digest(),
  );

  return `${signingInput}.${signature}`;
}
