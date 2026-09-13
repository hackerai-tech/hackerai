import {
  assertTriggerRunRegion,
  getExecutionRegionForVercelRequest,
  getRegionalExecutionContextForVercelRequest,
  getTriggerRegionForVercelRequest,
} from "../trigger-region";

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

  test("routes European country data to eu-central-1 without a continent header", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: "DE",
      }),
    ).toBe("eu-central-1");
  });

  test("normalizes European country data", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({}), {
        country: " gb ",
      }),
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

  test("resolves an explicit default for downstream execution", () => {
    expect(getExecutionRegionForVercelRequest(requestWithHeaders({}))).toBe(
      "us-east-1",
    );
  });

  test("keeps user geography separate from the default execution region", () => {
    expect(
      getRegionalExecutionContextForVercelRequest(requestWithHeaders({})),
    ).toEqual({
      triggerRegion: "us-east-1",
      requestRegionClass: "unknown",
    });
  });

  test("classifies a known non-European request independently of Trigger placement", () => {
    expect(
      getRegionalExecutionContextForVercelRequest(
        requestWithHeaders({ "x-vercel-ip-continent": "AS" }),
        { country: "IN" },
      ),
    ).toEqual({
      triggerRegion: "us-east-1",
      requestRegionClass: "outside_europe",
    });
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

  test("accepts a deployed European Trigger run in the requested region", () => {
    expect(() =>
      assertTriggerRunRegion({
        requestedRegion: "eu-central-1",
        actualRegion: "eu-central-1",
        environmentType: "PREVIEW",
      }),
    ).not.toThrow();
  });

  test("fails a deployed European run when Trigger reports another region", () => {
    expect(() =>
      assertTriggerRunRegion({
        requestedRegion: "eu-central-1",
        actualRegion: "us-east-1",
        environmentType: "PRODUCTION",
      }),
    ).toThrow(
      expect.objectContaining({
        name: "TriggerRegionMismatchError",
        code: "TRIGGER_REGION_MISMATCH",
      }),
    );
  });

  test("fails closed when a deployed European run has no region evidence", () => {
    expect(() =>
      assertTriggerRunRegion({
        requestedRegion: "eu-central-1",
        environmentType: "PREVIEW",
      }),
    ).toThrow("required eu-central-1, received unknown");
  });

  test.each(["us-east-1", "us-west-2"] as const)(
    "validates actual placement for deployed %s runs before provider selection",
    (requestedRegion) => {
      expect(() =>
        assertTriggerRunRegion({
          requestedRegion,
          actualRegion: requestedRegion,
          environmentType: "PREVIEW",
        }),
      ).not.toThrow();
      for (const actualRegion of ["eu-central-1", "unknown", undefined]) {
        expect(() =>
          assertTriggerRunRegion({
            requestedRegion,
            actualRegion,
            environmentType: "PRODUCTION",
          }),
        ).toThrow(expect.objectContaining({ code: "TRIGGER_REGION_MISMATCH" }));
      }
    },
  );

  test("does not silently substitute another US storage region", () => {
    expect(() =>
      assertTriggerRunRegion({
        requestedRegion: "us-west-2",
        actualRegion: "us-east-1",
        environmentType: "PREVIEW",
      }),
    ).toThrow("required us-west-2, received us-east-1");
  });

  test("allows local Trigger development where region selection is unavailable", () => {
    expect(() =>
      assertTriggerRunRegion({
        requestedRegion: "eu-central-1",
        environmentType: "DEVELOPMENT",
      }),
    ).not.toThrow();
  });
});
