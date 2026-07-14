import { getTriggerRegionForVercelRequest } from "../trigger-region";

function requestWithHeaders(headers: Record<string, string | undefined>) {
  return {
    headers: new Headers(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

describe("getTriggerRegionForVercelRequest", () => {
  test("routes European requests to eu-central-1", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": "EU",
        }),
      ),
    ).toBe("eu-central-1");
  });

  test("routes US east requests to us-east-1", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "US",
        latitude: "40.7128",
        longitude: "-74.006",
      }),
    ).toBe("us-east-1");
  });

  test("routes US west requests to us-west-2", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "US",
        latitude: "37.7749",
        longitude: "-122.4194",
      }),
    ).toBe("us-west-2");
  });

  test("routes Canadian east requests to us-east-1", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "CA",
        latitude: "43.6532",
        longitude: "-79.3832",
      }),
    ).toBe("us-east-1");
  });

  test("routes Canadian west requests to us-west-2", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "CA",
        latitude: "49.2827",
        longitude: "-123.1207",
      }),
    ).toBe("us-west-2");
  });

  test("uses Vercel coordinate headers before edge-region fallback", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-id": "iad1::iad1::abc123",
          "x-vercel-ip-continent": "NA",
          "x-vercel-ip-latitude": "47.6062",
          "x-vercel-ip-longitude": "-122.3321",
        }),
      ),
    ).toBe("us-west-2");
  });

  test("uses the Vercel request region when coordinates are unavailable", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "US",
        region: "pdx1",
      }),
    ).toBe("us-west-2");
  });

  test("uses x-vercel-id when coordinates and parsed location are unavailable", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": "NA",
          "x-vercel-id": "pdx1::iad1::abc123",
        }),
      ),
    ).toBe("us-west-2");
  });

  test("returns undefined for non-European, non-North-American locations", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "IN",
        latitude: "19.076",
        longitude: "72.8777",
        region: "pdx1",
      }),
    ).toBeUndefined();
  });

  test("uses the dashboard default region when Vercel headers are unavailable", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({})),
    ).toBeUndefined();
  });

  test("normalizes Vercel header values", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": " eu ",
        }),
      ),
    ).toBe("eu-central-1");
  });
});
