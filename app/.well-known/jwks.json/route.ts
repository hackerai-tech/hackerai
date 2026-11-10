import { publicJwks } from "@/lib/selfhost/session";
import { localOnly } from "@/lib/selfhost/http";
export async function GET() {
  const unavailable = localOnly();
  if (unavailable) return unavailable;
  return Response.json(await publicJwks(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
