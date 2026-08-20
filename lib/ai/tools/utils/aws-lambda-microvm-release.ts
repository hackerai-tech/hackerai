import type { TriggerRunRegion } from "@/lib/api/trigger-region";

export const AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV =
  "AWS_LAMBDA_MICROVM_RELEASE_MANIFEST" as const;
export const AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION = 1 as const;
export const AWS_LAMBDA_MICROVM_DEFAULT_REGION = "us-east-1" as const;
export const AWS_LAMBDA_MICROVM_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
] as const;

export type AwsLambdaMicrovmRegion =
  (typeof AWS_LAMBDA_MICROVM_REGIONS)[number];

export type AwsLambdaMicrovmReleaseRegion = {
  imageIdentifier: string;
  imageVersion: string;
  executionRoleArn: string;
  enabledForNewPlacements: boolean;
};

export type AwsLambdaMicrovmReleaseManifest = {
  schemaVersion: typeof AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION;
  releaseId: string;
  regions: Record<AwsLambdaMicrovmRegion, AwsLambdaMicrovmReleaseRegion>;
};

export type AwsLambdaMicrovmPlacement = {
  triggerRegion: TriggerRunRegion;
  requestedRegion: AwsLambdaMicrovmRegion;
  region: AwsLambdaMicrovmRegion;
  reason:
    | "trigger_region_exact"
    | "trigger_region_europe_pairing"
    | "regional_placement_disabled"
    | "invalid_trigger_region";
};

const TRIGGER_TO_AWS_REGION: Record<TriggerRunRegion, AwsLambdaMicrovmRegion> =
  {
    "us-east-1": "us-east-1",
    "us-west-2": "us-west-2",
    "eu-central-1": "eu-west-1",
  };

const AWS_LAMBDA_MICROVM_FAILOVER_ORDER: Record<
  AwsLambdaMicrovmRegion,
  readonly AwsLambdaMicrovmRegion[]
> = {
  "us-east-1": ["us-west-2", "eu-west-1"],
  "us-west-2": ["us-east-1", "eu-west-1"],
  "eu-west-1": ["us-east-1", "us-west-2"],
};

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function parseReleaseRegion(
  value: unknown,
  region: AwsLambdaMicrovmRegion,
): AwsLambdaMicrovmReleaseRegion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`regions.${region} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const imageIdentifier = nonEmptyString(
    record.imageIdentifier,
    `regions.${region}.imageIdentifier`,
  );
  if (!imageIdentifier.startsWith(`arn:aws:lambda:${region}:`)) {
    throw new Error(
      `regions.${region}.imageIdentifier must be an ARN in ${region}`,
    );
  }
  const executionRoleArn = nonEmptyString(
    record.executionRoleArn,
    `regions.${region}.executionRoleArn`,
  );
  if (!executionRoleArn.startsWith("arn:aws:iam::")) {
    throw new Error(
      `regions.${region}.executionRoleArn must be an IAM role ARN`,
    );
  }
  if (typeof record.enabledForNewPlacements !== "boolean") {
    throw new Error(
      `regions.${region}.enabledForNewPlacements must be a boolean`,
    );
  }
  return {
    imageIdentifier,
    imageVersion: nonEmptyString(
      record.imageVersion,
      `regions.${region}.imageVersion`,
    ),
    executionRoleArn,
    enabledForNewPlacements: record.enabledForNewPlacements,
  };
}

export function parseAwsLambdaMicrovmReleaseManifest(
  raw: string,
): AwsLambdaMicrovmReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV} must be JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV} must be an object`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION) {
    throw new Error(
      `${AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV}.schemaVersion must be ${AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION}`,
    );
  }
  if (
    !record.regions ||
    typeof record.regions !== "object" ||
    Array.isArray(record.regions)
  ) {
    throw new Error(
      `${AWS_LAMBDA_MICROVM_RELEASE_MANIFEST_ENV}.regions must be an object`,
    );
  }
  const regions = record.regions as Record<string, unknown>;
  const manifest: AwsLambdaMicrovmReleaseManifest = {
    schemaVersion: AWS_LAMBDA_MICROVM_RELEASE_SCHEMA_VERSION,
    releaseId: nonEmptyString(record.releaseId, "releaseId"),
    regions: {
      "us-east-1": parseReleaseRegion(regions["us-east-1"], "us-east-1"),
      "us-west-2": parseReleaseRegion(regions["us-west-2"], "us-west-2"),
      "eu-west-1": parseReleaseRegion(regions["eu-west-1"], "eu-west-1"),
    },
  };
  if (
    !manifest.regions[AWS_LAMBDA_MICROVM_DEFAULT_REGION].enabledForNewPlacements
  ) {
    throw new Error(
      `${AWS_LAMBDA_MICROVM_DEFAULT_REGION} must remain enabled for automatic fallback`,
    );
  }
  return manifest;
}

export function resolveAwsLambdaMicrovmPlacement(
  triggerRegion: TriggerRunRegion | string,
  manifest: AwsLambdaMicrovmReleaseManifest,
): AwsLambdaMicrovmPlacement {
  if (!Object.hasOwn(TRIGGER_TO_AWS_REGION, triggerRegion)) {
    return {
      triggerRegion: "us-east-1",
      requestedRegion: AWS_LAMBDA_MICROVM_DEFAULT_REGION,
      region: AWS_LAMBDA_MICROVM_DEFAULT_REGION,
      reason: "invalid_trigger_region",
    };
  }
  const normalizedTriggerRegion = triggerRegion as TriggerRunRegion;
  const requestedRegion = TRIGGER_TO_AWS_REGION[normalizedTriggerRegion];
  const requested = manifest.regions[requestedRegion];
  if (!requested.enabledForNewPlacements) {
    return {
      triggerRegion: normalizedTriggerRegion,
      requestedRegion,
      region: AWS_LAMBDA_MICROVM_DEFAULT_REGION,
      reason: "regional_placement_disabled",
    };
  }
  return {
    triggerRegion: normalizedTriggerRegion,
    requestedRegion,
    region: requestedRegion,
    reason:
      normalizedTriggerRegion === "eu-central-1"
        ? "trigger_region_europe_pairing"
        : "trigger_region_exact",
  };
}

/**
 * Select one alternate region for a new-session capacity failover.
 *
 * The order is deterministic, and administratively disabled regions are
 * skipped. Callers make at most one cross-region attempt with the returned
 * region; they do not cascade through the remaining entries after a failure.
 */
export function resolveAwsLambdaMicrovmFailoverRegion(
  failedRegion: AwsLambdaMicrovmRegion,
  manifest: AwsLambdaMicrovmReleaseManifest,
): AwsLambdaMicrovmRegion | undefined {
  return AWS_LAMBDA_MICROVM_FAILOVER_ORDER[failedRegion].find(
    (region) => manifest.regions[region].enabledForNewPlacements,
  );
}
