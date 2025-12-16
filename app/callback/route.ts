import { handleAuth } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const authHandler = handleAuth();

const isValidLocalPath = (path: string): boolean => {
  return (
    path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
  );
};

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const redirectPath = cookieStore.get("post_login_redirect")?.value;

  if (redirectPath) cookieStore.delete("post_login_redirect");

  // Authkit returns error responses instead of throwing, so we check status codes
  const response = await authHandler(request);

  if (
    redirectPath &&
    isValidLocalPath(redirectPath) &&
    [302, 307].includes(response.status)
  ) {
    return NextResponse.redirect(new URL(redirectPath, request.url));
  }

  if (response.status >= 400) {
    const body = await response.json().catch(() => null);
    console.warn("Authkit returned an error code", response.status, body);
    return NextResponse.redirect(
      new URL(`/auth-error?code=${response.status}`, request.url),
    );
  }

  return response;
}
