import {
  buildAwsLambdaMicrovmReleaseManifest,
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
    expect(serializeAwsLambdaMicrovmReleaseEnvironment(manifest)).toContain(
      `AWS_LAMBDA_MICROVM_RELEASE_MANIFEST=${JSON.stringify(manifest)}`,
    );
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
