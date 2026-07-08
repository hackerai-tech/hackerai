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

  test("routes European parsed locations to eu-central-1", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "DE",
      }),
    ).toBe("eu-central-1");
  });

  test("routes US east requests to us-east-1", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "US",
        countryRegion: "NY",
      }),
    ).toBe("us-east-1");
  });

  test("routes US west requests to us-west-2", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "US",
        countryRegion: "CA",
      }),
    ).toBe("us-west-2");
  });

  test("routes Canadian east requests to us-east-1", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "CA",
        countryRegion: "ON",
      }),
    ).toBe("us-east-1");
  });

  test("routes Canadian west requests to us-west-2", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "CA",
        countryRegion: "BC",
      }),
    ).toBe("us-west-2");
  });

  test("uses coordinates before coarse subdivisions", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "US",
        countryRegion: "NY",
        latitude: "47.6062",
        longitude: "-122.3321",
      }),
    ).toBe("us-west-2");
  });

  test("uses the Vercel request region when user geography is unavailable", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
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
