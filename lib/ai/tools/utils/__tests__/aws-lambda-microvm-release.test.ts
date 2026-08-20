import {
  parseAwsLambdaMicrovmReleaseManifest,
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
      enabledForNewPlacements: true,
    },
    "us-west-2": {
      imageIdentifier:
        "arn:aws:lambda:us-west-2:123456789012:microvm-image:hackerai",
      imageVersion: "8.0",
      executionRoleArn: "arn:aws:iam::123456789012:role/west",
      enabledForNewPlacements: true,
    },
    "eu-west-1": {
      imageIdentifier:
        "arn:aws:lambda:eu-west-1:123456789012:microvm-image:hackerai",
      imageVersion: "3.0",
      executionRoleArn: "arn:aws:iam::123456789012:role/eu",
      enabledForNewPlacements: true,
    },
  },
});

describe("AWS Lambda MicroVM release manifest", () => {
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
});
