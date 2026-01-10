import { NextResponse } from "next/server";
import { WorkOS } from "@workos-inc/node";

const workos = new WorkOS(process.env.WORKOS_API_KEY);

export async function GET(request: Request) {
  const url = new URL(request.url);

  const desktopCallbackUrl = `${url.origin}/api/auth/desktop-callback`;

  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: process.env.WORKOS_CLIENT_ID!,
    redirectUri: desktopCallbackUrl,
  });

  return NextResponse.redirect(authorizationUrl);
}
