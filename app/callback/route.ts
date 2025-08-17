import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";
import { isWorkOSEnabled } from "@/lib/auth-utils";

// Redirect the user to `/` after successful sign in
// The redirect can be customized: `handleAuth({ returnPathname: '/foo' })`
export const GET = isWorkOSEnabled()
  ? handleAuth()
  : () =>
      NextResponse.redirect(
        new URL(
          "/",
          process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000",
        ),
      );
