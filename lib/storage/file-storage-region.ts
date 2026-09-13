import { isS3StorageRegion, type S3StorageRegion } from "@/lib/constants/s3";

export async function getPreferredFileStorageRegion(): Promise<
  S3StorageRegion | undefined
> {
  try {
    const response = await fetch("/api/file-storage/region", {
      cache: "no-store",
    });
    if (!response.ok) return undefined;

    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("region" in data)) {
      return undefined;
    }

    const region = (data as { region?: unknown }).region;
    return typeof region === "string" && isS3StorageRegion(region)
      ? region
      : undefined;
  } catch {
    // Region selection is an optimization. Convex safely falls back to the
    // legacy bucket when this request is unavailable.
    return undefined;
  }
}
