export type TriggerRunRegion = "eu-central-1" | "us-east-1" | "us-west-2";

type VercelGeoLocation = {
  country?: string;
  countryRegion?: string;
  region?: string;
  latitude?: string;
  longitude?: string;
};

const EUROPEAN_COUNTRY_CODES = new Set([
  "AD",
  "AL",
  "AT",
  "AX",
  "BA",
  "BE",
  "BG",
  "BY",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FO",
  "FR",
  "GB",
  "GG",
  "GI",
  "GR",
  "HR",
  "HU",
  "IE",
  "IM",
  "IS",
  "IT",
  "JE",
  "LI",
  "LT",
  "LU",
  "LV",
  "MC",
  "MD",
  "ME",
  "MK",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RS",
  "SE",
  "SI",
  "SJ",
  "SK",
  "SM",
  "TR",
  "UA",
  "VA",
  "XK",
]);

const NORTH_AMERICAN_COUNTRY_CODES = new Set(["CA", "MX", "US"]);

const WESTERN_US_SUBDIVISIONS = new Set([
  "AK",
  "AS",
  "AZ",
  "CA",
  "CO",
  "GU",
  "HI",
  "ID",
  "MP",
  "MT",
  "NM",
  "NV",
  "OR",
  "UT",
  "WA",
  "WY",
]);

const US_SUBDIVISIONS = new Set([
  "AK",
  "AL",
  "AR",
  "AS",
  "AZ",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "GA",
  "GU",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MI",
  "MN",
  "MO",
  "MP",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "PR",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UM",
  "UT",
  "VA",
  "VI",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
]);

const WESTERN_CANADA_SUBDIVISIONS = new Set([
  "AB",
  "BC",
  "NT",
  "NU",
  "SK",
  "YT",
]);

const CANADA_SUBDIVISIONS = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);

const VERCEL_REGION_TO_US_TRIGGER_REGION = new Map<string, TriggerRunRegion>([
  ["CLE1", "us-east-1"],
  ["IAD1", "us-east-1"],
  ["YUL1", "us-east-1"],
  ["PDX1", "us-west-2"],
  ["SFO1", "us-west-2"],
]);

const US_EAST_1_COORDINATES = { latitude: 39.0438, longitude: -77.4874 };
const US_WEST_2_COORDINATES = { latitude: 45.8399, longitude: -119.7006 };

function normalizeVercelValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function parseCoordinate(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function distanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
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
  latitude: number | null,
  longitude: number | null,
): TriggerRunRegion | undefined {
  if (latitude === null || longitude === null) return undefined;

  const userCoordinates = { latitude, longitude };
  const eastDistance = distanceKm(userCoordinates, US_EAST_1_COORDINATES);
  const westDistance = distanceKm(userCoordinates, US_WEST_2_COORDINATES);

  return eastDistance <= westDistance ? "us-east-1" : "us-west-2";
}

function getUsTriggerRegionForSubdivision(
  country: string | null,
  subdivision: string | null,
): TriggerRunRegion | undefined {
  if (!country || !subdivision) return undefined;

  if (country === "US" && US_SUBDIVISIONS.has(subdivision)) {
    return WESTERN_US_SUBDIVISIONS.has(subdivision) ? "us-west-2" : "us-east-1";
  }

  if (country === "CA" && CANADA_SUBDIVISIONS.has(subdivision)) {
    return WESTERN_CANADA_SUBDIVISIONS.has(subdivision)
      ? "us-west-2"
      : "us-east-1";
  }

  return undefined;
}

function getVercelRegionFromId(value: string | null): string | null {
  const normalizedSegments = value
    ?.split("::")
    .map((segment) => normalizeVercelValue(segment));

  return (
    normalizedSegments?.find(
      (segment): segment is string =>
        !!segment && VERCEL_REGION_TO_US_TRIGGER_REGION.has(segment),
    ) ?? null
  );
}

function shouldRouteToUsTriggerRegion(
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
  const country = normalizeVercelValue(
    userLocation?.country ?? request.headers.get("x-vercel-ip-country"),
  );

  if (continent === "EU" || (country && EUROPEAN_COUNTRY_CODES.has(country))) {
    return "eu-central-1";
  }

  if (shouldRouteToUsTriggerRegion(continent, country)) {
    const latitude = parseCoordinate(
      userLocation?.latitude ?? request.headers.get("x-vercel-ip-latitude"),
    );
    const longitude = parseCoordinate(
      userLocation?.longitude ?? request.headers.get("x-vercel-ip-longitude"),
    );
    const coordinateRegion = getClosestUsTriggerRegion(latitude, longitude);
    if (coordinateRegion) return coordinateRegion;

    const countryRegion = normalizeVercelValue(
      userLocation?.countryRegion ??
        request.headers.get("x-vercel-ip-country-region"),
    );
    const subdivisionRegion = getUsTriggerRegionForSubdivision(
      country,
      countryRegion,
    );
    if (subdivisionRegion) return subdivisionRegion;
  }

  const vercelRegion =
    normalizeVercelValue(userLocation?.region) ??
    getVercelRegionFromId(request.headers.get("x-vercel-id"));

  if (!vercelRegion) return undefined;
  if (
    !shouldRouteToUsTriggerRegion(continent, country) &&
    (continent || country)
  ) {
    return undefined;
  }

  return VERCEL_REGION_TO_US_TRIGGER_REGION.get(vercelRegion);
}
