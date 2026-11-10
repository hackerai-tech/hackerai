import { NextResponse, type NextRequest } from "next/server";
import { isSelfHosted } from "./config";
import { readSession, SESSION_COOKIE } from "./session";

export function sameOrigin(request: Request) {
  return request.headers.get("origin") === process.env.NEXT_PUBLIC_BASE_URL;
}

export async function selfHostProxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    /^\/(?:api\/(?:workos|subscription|extra-usage|fraud|influencers|team|internal|cron|agent-goal)|signup|callback|desktop-login|desktop-callback|invite|pricing|r)(?:\/|$)/.test(
      path,
    )
  ) {
    return NextResponse.json(
      {
        error:
          "Recurso da plataforma externa indisponível nesta instalação local.",
      },
      { status: 404 },
    );
  }
  if (
    path.startsWith("/api/local-auth/") ||
    path === "/local-login" ||
    path === "/.well-known/jwks.json"
  )
    return NextResponse.next();
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return path.startsWith("/api/")
      ? NextResponse.json(
          { error: "Entre na sua conta para continuar." },
          { status: 401 },
        )
      : NextResponse.redirect(
          new URL("/local-login", process.env.NEXT_PUBLIC_BASE_URL),
        );
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !sameOrigin(request)
  ) {
    return NextResponse.json(
      { error: "Origem da requisição inválida." },
      { status: 403 },
    );
  }
  const headers = new Headers(request.headers);
  headers.delete("x-workos-session");
  headers.set("x-workos-middleware", "true");
  return NextResponse.next({ request: { headers } });
}

export function localOnly() {
  return isSelfHosted()
    ? null
    : NextResponse.json({ error: "Não encontrado." }, { status: 404 });
}
