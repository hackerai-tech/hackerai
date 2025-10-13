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

  const originalError = console.error;
  try {
    console.error = (...args: unknown[]) => {
      const message = String(args[0]);
      if (
        message.includes("invalid_grant") ||
        message.includes("InvalidCharacterError")
      ) {
        return;
      }
      originalError.apply(console, args);
    };

    const response = await authHandler(request);

    if (
      redirectPath &&
      isValidLocalPath(redirectPath) &&
      [302, 307].includes(response.status)
    ) {
      return NextResponse.redirect(new URL(redirectPath, request.url));
    }

    return response;
  } catch (error) {
    const errorMessage = String(error);
    if (
      errorMessage.includes("invalid_grant") ||
      errorMessage.includes("InvalidCharacterError")
    ) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    throw error;
  } finally {
    console.error = originalError;
  }
}
