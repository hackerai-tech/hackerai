import { NextRequest, NextResponse } from "next/server";

export const POST = async (req: NextRequest) => {
  const headers = new Headers();
  const cookieAttrs =
    "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax";
  const names = ["wos-session", "wos-session-v2", "wos-user"];

  // Clear for current host
  for (const name of names) {
    headers.append("Set-Cookie", `${name}=; ${cookieAttrs}`);
  }

  // Also attempt to clear for parent domain (e.g., .example.com)
  const host = req.headers.get("host") ?? "";
  const parts = host.split(".");
  if (parts.length >= 2) {
    const parent = "." + parts.slice(-2).join(".");
    for (const name of names) {
      headers.append(
        "Set-Cookie",
        `${name}=; ${cookieAttrs}; Domain=${parent}`,
      );
    }
  }

  return new NextResponse(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
};
