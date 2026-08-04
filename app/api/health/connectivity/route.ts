export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function HEAD() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
