import {
  parseAwsLambdaMicrovmReleaseManifest,
  resolveAwsLambdaMicrovmFailoverRegion,
  resolveAwsLambdaMicrovmPlacement,
} from "../aws-lambda-microvm-release";

const manifest = () => ({
  schemaVersion: 1,
  releaseId: "release-sha",
  regions: {
    "us-east-1": {
      imageIdentifier:
        "arn:aws:lambda:us-east-1:123456789012:microvm-image:hackerai",
      imageVersion: "15.0",
      executionRoleArn: "arn:aws:iam::123456789012:role/east",
      egressConnectorArn:
        "arn:aws:lambda:us-east-1:123456789012:network-connector:hackerai-static-egress:1",
      egressIpv4Address: "192.0.2.10",
      enabledForNewPlacements: true,
    },
    "us-west-2": {
      imageIdentifier:
        "arn:aws:lambda:us-west-2:123456789012:microvm-image:hackerai",
      imageVersion: "8.0",
      executionRoleArn: "arn:aws:iam::123456789012:role/west",
      egressConnectorArn:
        "arn:aws:lambda:us-west-2:123456789012:network-connector:hackerai-static-egress:1",
      egressIpv4Address: "192.0.2.20",
      enabledForNewPlacements: true,
    },
    "eu-west-1": {
      imageIdentifier:
        "arn:aws:lambda:eu-west-1:123456789012:microvm-image:hackerai",
      imageVersion: "3.0",
      executionRoleArn: "arn:aws:iam::123456789012:role/eu",
      egressConnectorArn:
        "arn:aws:lambda:eu-west-1:123456789012:network-connector:hackerai-static-egress:1",
      egressIpv4Address: "192.0.2.30",
      enabledForNewPlacements: true,
    },
  },
});

describe("AWS Lambda MicroVM release manifest", () => {
  it("keeps the regional connector and reserved IPv4 in the parsed catalog", () => {
    const parsed = parseAwsLambdaMicrovmReleaseManifest(
      JSON.stringify(manifest()),
    );
    expect(parsed.regions["us-west-2"]).toMatchObject({
      egressConnectorArn:
        "arn:aws:lambda:us-west-2:123456789012:network-connector:hackerai-static-egress:1",
      egressIpv4Address: "192.0.2.20",
    });
  });

  it("keeps legacy manifests on managed internet egress during migration", () => {
    const legacy = manifest();
    delete (legacy.regions["us-east-1"] as { egressConnectorArn?: string })
      .egressConnectorArn;
    const parsed = parseAwsLambdaMicrovmReleaseManifest(JSON.stringify(legacy));
    expect(parsed.regions["us-east-1"].egressConnectorArn).toBe(
      "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
    );
  });

  it.each([
    ["us-east-1", "us-east-1", "trigger_region_exact"],
    ["us-west-2", "us-west-2", "trigger_region_exact"],
    ["eu-central-1", "eu-west-1", "trigger_region_europe_pairing"],
  ] as const)("maps Trigger %s to AWS %s", (triggerRegion, region, reason) => {
    const parsed = parseAwsLambdaMicrovmReleaseManifest(
      JSON.stringify(manifest()),
    );
    expect(resolveAwsLambdaMicrovmPlacement(triggerRegion, parsed)).toEqual({
      triggerRegion,
      requestedRegion: region,
      region,
      reason,
    });
  });

  it("falls new placements back to US East when a regional release is disabled", () => {
    const input = manifest();
    input.regions["eu-west-1"].enabledForNewPlacements = false;
    const parsed = parseAwsLambdaMicrovmReleaseManifest(JSON.stringify(input));
    expect(resolveAwsLambdaMicrovmPlacement("eu-central-1", parsed)).toEqual({
      triggerRegion: "eu-central-1",
      requestedRegion: "eu-west-1",
      region: "us-east-1",
      reason: "regional_placement_disabled",
    });
  });

  it("falls back safely when a serialized task contains an unknown region", () => {
    const parsed = parseAwsLambdaMicrovmReleaseManifest(
      JSON.stringify(manifest()),
    );
    expect(resolveAwsLambdaMicrovmPlacement("ap-southeast-1", parsed)).toEqual({
      triggerRegion: "us-east-1",
      requestedRegion: "us-east-1",
      region: "us-east-1",
      reason: "invalid_trigger_region",
    });
  });

  it("rejects cross-region image ARNs and a disabled fallback", () => {
    const wrongArn = manifest();
    wrongArn.regions["us-west-2"].imageIdentifier =
      "arn:aws:lambda:us-east-1:123456789012:microvm-image:hackerai";
    expect(() =>
      parseAwsLambdaMicrovmReleaseManifest(JSON.stringify(wrongArn)),
    ).toThrow("must be an ARN in us-west-2");

    const disabledFallback = manifest();
    disabledFallback.regions["us-east-1"].enabledForNewPlacements = false;
    expect(() =>
      parseAwsLambdaMicrovmReleaseManifest(JSON.stringify(disabledFallback)),
    ).toThrow("us-east-1 must remain enabled");
  });

  it.each([
    ["us-east-1", "us-west-2"],
    ["us-west-2", "us-east-1"],
    ["eu-west-1", "us-east-1"],
  ] as const)(
    "selects the first enabled failover region after %s",
    (failedRegion, expectedRegion) => {
      const parsed = parseAwsLambdaMicrovmReleaseManifest(
        JSON.stringify(manifest()),
      );
      expect(resolveAwsLambdaMicrovmFailoverRegion(failedRegion, parsed)).toBe(
        expectedRegion,
      );
    },
  );

  it("skips disabled alternates and returns no region when none remain", () => {
    const withWestDisabled = manifest();
    withWestDisabled.regions["us-west-2"].enabledForNewPlacements = false;
    const parsed = parseAwsLambdaMicrovmReleaseManifest(
      JSON.stringify(withWestDisabled),
    );
    expect(resolveAwsLambdaMicrovmFailoverRegion("us-east-1", parsed)).toBe(
      "eu-west-1",
    );

    const withoutAlternates = manifest();
    withoutAlternates.regions["us-west-2"].enabledForNewPlacements = false;
    withoutAlternates.regions["eu-west-1"].enabledForNewPlacements = false;
    expect(
      resolveAwsLambdaMicrovmFailoverRegion(
        "us-east-1",
        parseAwsLambdaMicrovmReleaseManifest(JSON.stringify(withoutAlternates)),
      ),
    ).toBeUndefined();
  });
});
