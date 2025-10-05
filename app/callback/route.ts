import { handleAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const authHandler = handleAuth();

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;
  
  if (redirectPath) cookieStore.delete("post_login_redirect");
  
  const response = await authHandler(request);
  
  if (redirectPath?.startsWith("/") && [302, 307].includes(response.status)) {
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }
  
  return response;
}
