import { redeemDesktopOperation } from "@/lib/desktop/authorized-operation";

export const runtime = "nodejs";

/** Native Desktop redeems an unguessable, short-lived operation once. */
export async function POST(request: Request): Promise<Response> {
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return Response.json({ error: "Native request required" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const id = body?.id;
  const digest = body?.digest;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
    return Response.json({ error: "Invalid operation" }, { status: 400 });
  }
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    return Response.json({ error: "Invalid operation" }, { status: 400 });
  }
  try {
    const operation = await redeemDesktopOperation(id);
    if (!operation) {
      return Response.json({ error: "Operation unavailable" }, { status: 404 });
    }
    if (operation.digest !== digest) {
      return Response.json({ error: "Operation mismatch" }, { status: 403 });
    }
    return Response.json(
      { approved: true },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json({ error: "Operation unavailable" }, { status: 503 });
  }
}
