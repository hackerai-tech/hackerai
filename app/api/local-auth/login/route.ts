import { createClient } from "redis";
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  checkPassword,
  SESSION_COOKIE,
  signSession,
} from "@/lib/selfhost/session";
import { localOnly, sameOrigin } from "@/lib/selfhost/http";

let connection: ReturnType<typeof createClient> | undefined;
let connecting: Promise<unknown> | undefined;
async function limiter() {
  if (!process.env.REDIS_URL)
    throw new Error("REDIS_URL obrigatório para proteger o login.");
  if (!connection) {
    connection = createClient({
      url: process.env.REDIS_URL,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2000 },
    });
    connection.on("error", () => {});
    connecting = connection.connect();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Login store unavailable")),
      2500,
    );
    connecting!.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  return connection;
}

export async function POST(request: NextRequest) {
  const unavailable = localOnly();
  if (unavailable) return unavailable;
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Origem inválida." }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 4096)
    return new Response(null, { status: 413 });
  try {
    const redis = await limiter();
    // Caddy overwrites this header with the direct peer address.
    const address = request.headers.get("x-real-ip") ?? "unknown";
    const id = createHash("sha256").update(address).digest("hex");
    const count = (await redis.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
      { keys: [`local-login:${id}`] },
    )) as number;
    if (count > 10)
      return NextResponse.json(
        { error: "Muitas tentativas. Aguarde 15 minutos." },
        { status: 429, headers: { "Retry-After": "900" } },
      );
    const raw = await request.text();
    if (raw.length > 4096) return new Response(null, { status: 413 });
    const body = JSON.parse(raw);
    if (
      typeof body.email !== "string" ||
      typeof body.password !== "string" ||
      !(await checkPassword(body.email, body.password))
    ) {
      return NextResponse.json(
        { error: "E-mail ou senha incorretos." },
        { status: 401 },
      );
    }
    const response = NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
    response.cookies.set(SESSION_COOKIE, await signSession(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 43200,
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: "Login temporariamente indisponível." },
      { status: 503 },
    );
  }
}
