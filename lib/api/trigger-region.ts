import type { Geo } from "@vercel/functions";

export type TriggerRunRegion = "eu-central-1" | "us-east-1" | "us-west-2";

type VercelGeoLocation = Pick<
  Geo,
  "country" | "region" | "latitude" | "longitude"
>;

type Coordinates = {
  latitude: number;
  longitude: number;
};

type UsTriggerRunRegion = Exclude<TriggerRunRegion, "eu-central-1">;

const NORTH_AMERICAN_COUNTRY_CODES = new Set(["CA", "MX", "US"]);

const VERCEL_REGION_TO_US_TRIGGER_REGION = new Map<string, UsTriggerRunRegion>([
  ["CLE1", "us-east-1"],
  ["IAD1", "us-east-1"],
  ["YUL1", "us-east-1"],
  ["PDX1", "us-west-2"],
  ["SFO1", "us-west-2"],
]);

const US_TRIGGER_REGION_COORDINATES: Record<UsTriggerRunRegion, Coordinates> = {
  "us-east-1": { latitude: 39.0438, longitude: -77.4874 },
  "us-west-2": { latitude: 45.8399, longitude: -119.7006 },
};

function normalizeVercelValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function parseCoordinate(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function getCoordinates(
  request: { headers: Headers },
  userLocation?: VercelGeoLocation,
): Coordinates | null {
  const latitude = parseCoordinate(
    userLocation?.latitude ?? request.headers.get("x-vercel-ip-latitude"),
  );
  const longitude = parseCoordinate(
    userLocation?.longitude ?? request.headers.get("x-vercel-ip-longitude"),
  );

  return latitude === null || longitude === null
    ? null
    : { latitude, longitude };
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function distanceKm(from: Coordinates, to: Coordinates): number {
  const earthRadiusKm = 6371;
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return (
    2 *
    earthRadiusKm *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function getClosestUsTriggerRegion(
  coordinates: Coordinates,
): UsTriggerRunRegion {
  const eastDistance = distanceKm(
    coordinates,
    US_TRIGGER_REGION_COORDINATES["us-east-1"],
  );
  const westDistance = distanceKm(
    coordinates,
    US_TRIGGER_REGION_COORDINATES["us-west-2"],
  );

  return eastDistance <= westDistance ? "us-east-1" : "us-west-2";
}

function getVercelRegionFromId(value: string | null): string | null {
  return (
    value
      ?.split("::")
      .map((segment) => normalizeVercelValue(segment))
      .find(
        (segment): segment is string =>
          !!segment && VERCEL_REGION_TO_US_TRIGGER_REGION.has(segment),
      ) ?? null
  );
}

function isNorthAmericanRequest(
  continent: string | null,
  country: string | null,
): boolean {
  return (
    continent === "NA" ||
    (!!country && NORTH_AMERICAN_COUNTRY_CODES.has(country))
  );
}

export function getTriggerRegionForVercelRequest(
  request: {
    headers: Headers;
  },
  userLocation?: VercelGeoLocation,
): TriggerRunRegion | undefined {
  const continent = normalizeVercelValue(
    request.headers.get("x-vercel-ip-continent"),
  );
  if (continent === "EU") return "eu-central-1";

  const country = normalizeVercelValue(
    userLocation?.country ?? request.headers.get("x-vercel-ip-country"),
  );
  if (!isNorthAmericanRequest(continent, country)) {
    return undefined;
  }

  const coordinates = getCoordinates(request, userLocation);
  if (coordinates) return getClosestUsTriggerRegion(coordinates);

  const vercelRegion =
    normalizeVercelValue(userLocation?.region) ??
    getVercelRegionFromId(request.headers.get("x-vercel-id"));

  return vercelRegion
    ? VERCEL_REGION_TO_US_TRIGGER_REGION.get(vercelRegion)
    : undefined;
}
