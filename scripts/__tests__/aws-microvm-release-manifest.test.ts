import {
  buildAwsLambdaMicrovmReleaseManifest,
  parseAwsLambdaMicrovmEnabledRegions,
  parseRegionalReleaseOutput,
  serializeAwsLambdaMicrovmReleaseEnvironment,
} from "../lib/aws-microvm-release-manifest";

const output = (region: "us-east-1" | "us-west-2" | "eu-west-1") =>
  parseRegionalReleaseOutput(
    [
      `AWS_REGION=${region}`,
      `AWS_LAMBDA_MICROVM_IMAGE_ID=arn:aws:lambda:${region}:123456789012:microvm-image:hackerai`,
      "AWS_LAMBDA_MICROVM_IMAGE_VERSION=15.0",
      `AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/${region}`,
    ].join("\n"),
  );

describe("AWS Lambda MicroVM regional release manifest", () => {
  it("promotes exactly one validated entry for every supported region", () => {
    const manifest = buildAwsLambdaMicrovmReleaseManifest({
      releaseId: "abcdef",
      outputs: [output("eu-west-1"), output("us-east-1"), output("us-west-2")],
    });
    expect(manifest.releaseId).toBe("abcdef");
    expect(Object.keys(manifest.regions)).toEqual([
      "us-east-1",
      "us-west-2",
      "eu-west-1",
    ]);
    expect(manifest.regions["eu-west-1"].enabledForNewPlacements).toBe(true);
    expect(
      serializeAwsLambdaMicrovmReleaseEnvironment(manifest).split("\n"),
    ).toEqual([
      `AWS_LAMBDA_MICROVM_RELEASE_MANIFEST=${JSON.stringify(manifest)}`,
      `AWS_LAMBDA_MICROVM_IMAGE_ID=${manifest.regions["us-east-1"].imageIdentifier}`,
      "AWS_LAMBDA_MICROVM_IMAGE_VERSION=15.0",
      "AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=arn:aws:iam::123456789012:role/us-east-1",
    ]);
  });

  it("preserves disabled regional placement across later image releases", () => {
    const manifest = buildAwsLambdaMicrovmReleaseManifest({
      releaseId: "kill-switch",
      outputs: [output("us-east-1"), output("us-west-2"), output("eu-west-1")],
      enabledRegions: parseAwsLambdaMicrovmEnabledRegions(
        "us-east-1,eu-west-1",
      ),
    });

    expect(manifest.regions["us-east-1"].enabledForNewPlacements).toBe(true);
    expect(manifest.regions["us-west-2"].enabledForNewPlacements).toBe(false);
    expect(manifest.regions["eu-west-1"].enabledForNewPlacements).toBe(true);
  });

  it("rejects enabled-region inputs without the fallback region", () => {
    expect(() =>
      parseAwsLambdaMicrovmEnabledRegions("us-west-2,eu-west-1"),
    ).toThrow("must include us-east-1");
    expect(() =>
      parseAwsLambdaMicrovmEnabledRegions("us-east-1,ap-southeast-1"),
    ).toThrow("contains an unsupported region");
  });

  it("rejects partial and duplicate regional builds", () => {
    expect(() =>
      buildAwsLambdaMicrovmReleaseManifest({
        releaseId: "partial",
        outputs: [output("us-east-1"), output("us-west-2")],
      }),
    ).toThrow("Missing regional release output for eu-west-1");
    expect(() =>
      buildAwsLambdaMicrovmReleaseManifest({
        releaseId: "duplicate",
        outputs: [
          output("us-east-1"),
          output("us-east-1"),
          output("eu-west-1"),
        ],
      }),
    ).toThrow("duplicate AWS region");
  });
});
