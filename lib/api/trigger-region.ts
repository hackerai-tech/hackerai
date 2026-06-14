export type TriggerRunRegion = "eu-central-1" | "us-east-1";

function normalizeVercelHeader(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export function getTriggerRegionForVercelRequest(request: {
  headers: Headers;
}): TriggerRunRegion {
  const continent = normalizeVercelHeader(
    request.headers.get("x-vercel-ip-continent"),
  );

  return continent === "EU" ? "eu-central-1" : "us-east-1";
}
