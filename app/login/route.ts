import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

const ALLOWED_INTENTS: Record<string, string> = {
  pricing: "/#pricing",
  "migrate-pentestgpt": "/?confirm-migrate-pentestgpt=true",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const intent = url.searchParams.get("intent");
  const confirmMigrate = url.searchParams.get("confirm-migrate-pentestgpt");

  let redirectPath: string | null = null;
  if (intent && ALLOWED_INTENTS[intent]) {
    redirectPath = ALLOWED_INTENTS[intent];
  } else if (confirmMigrate === "true") {
    redirectPath = ALLOWED_INTENTS["migrate-pentestgpt"];
  }

  if (redirectPath) {
    const cookieStore = await cookies();
    cookieStore.set("post_login_redirect", redirectPath, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  }

  // AuthKit v4 sets the PKCE verifier via `cookies().set()` inside getSignInUrl.
  // Must use next/navigation's redirect() so Next flushes those cookie mutations
  // onto the outgoing response — a manual NextResponse.redirect() would drop them.
  const authorizationUrl = await getSignInUrl();
  redirect(authorizationUrl);
}
