import {
  AWS_LAMBDA_MICROVM_REGIONS,
  AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION,
  type AwsLambdaMicrovmRegion,
  type AwsLambdaMicrovmReleaseManifest,
  parseAwsLambdaMicrovmReleaseManifest,
} from "../../lib/ai/tools/utils/aws-lambda-microvm-release";

type RegionalReleaseOutput = {
  AWS_REGION: AwsLambdaMicrovmRegion;
  AWS_LAMBDA_MICROVM_IMAGE_ID: string;
  AWS_LAMBDA_MICROVM_IMAGE_VERSION: string;
  AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN: string;
};

function required(record: Record<string, string>, name: string): string {
  const value = record[name]?.trim();
  if (!value) throw new Error(`${name} is required in regional release output`);
  return value;
}

export function parseRegionalReleaseOutput(raw: string): RegionalReleaseOutput {
  const record: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Invalid regional release output line");
    record[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const region = required(record, "AWS_REGION");
  if (!AWS_LAMBDA_MICROVM_REGIONS.includes(region as AwsLambdaMicrovmRegion)) {
    throw new Error(`Unsupported AWS Lambda MicroVM release region ${region}`);
  }
  return {
    AWS_REGION: region as AwsLambdaMicrovmRegion,
    AWS_LAMBDA_MICROVM_IMAGE_ID: required(
      record,
      "AWS_LAMBDA_MICROVM_IMAGE_ID",
    ),
    AWS_LAMBDA_MICROVM_IMAGE_VERSION: required(
      record,
      "AWS_LAMBDA_MICROVM_IMAGE_VERSION",
    ),
    AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN: required(
      record,
      "AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
    ),
  };
}

export function buildAwsLambdaMicrovmReleaseManifest({
  releaseId,
  outputs,
}: {
  releaseId: string;
  outputs: RegionalReleaseOutput[];
}): AwsLambdaMicrovmReleaseManifest {
  const byRegion = new Map(
    outputs.map((output) => [output.AWS_REGION, output]),
  );
  if (byRegion.size !== outputs.length) {
    throw new Error("Regional release output contains a duplicate AWS region");
  }
  const regions = Object.fromEntries(
    AWS_LAMBDA_MICROVM_REGIONS.map((region) => {
      const output = byRegion.get(region);
      if (!output)
        throw new Error(`Missing regional release output for ${region}`);
      return [
        region,
        {
          imageIdentifier: output.AWS_LAMBDA_MICROVM_IMAGE_ID,
          imageVersion: output.AWS_LAMBDA_MICROVM_IMAGE_VERSION,
          executionRoleArn: output.AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN,
          enabledForNewPlacements: true,
        },
      ];
    }),
  ) as AwsLambdaMicrovmReleaseManifest["regions"];
  return parseAwsLambdaMicrovmReleaseManifest(
    JSON.stringify({
      schemaVersion: AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION,
      releaseId,
      regions,
    }),
  );
}

export function serializeAwsLambdaMicrovmReleaseEnvironment(
  manifest: AwsLambdaMicrovmReleaseManifest,
): string {
  const east = manifest.regions["us-east-1"];
  return [
    `AWS_LAMBDA_MICROVM_RELEASE_MANIFEST=${JSON.stringify(manifest)}`,
    `AWS_LAMBDA_MICROVM_IMAGE_ID=${east.imageIdentifier}`,
    `AWS_LAMBDA_MICROVM_IMAGE_VERSION=${east.imageVersion}`,
    `AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=${east.executionRoleArn}`,
  ].join("\n");
}
