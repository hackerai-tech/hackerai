import type { envvars } from "@trigger.dev/sdk";
import { parseAwsLambdaMicrovmReleaseManifest } from "../../lib/ai/tools/utils/aws-lambda-microvm-release";

export const TRIGGER_MICROVM_RELEASE_ENVIRONMENT = "prod" as const;

export const TRIGGER_MICROVM_RELEASE_ENV_NAMES = [
  "AWS_LAMBDA_MICROVM_RELEASE_MANIFEST",
  "AWS_LAMBDA_MICROVM_IMAGE_ID",
  "AWS_LAMBDA_MICROVM_IMAGE_VERSION",
  "AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
] as const;

type TriggerMicrovmReleaseEnvName =
  (typeof TRIGGER_MICROVM_RELEASE_ENV_NAMES)[number];

type TriggerEnvClient = Pick<typeof envvars, "upload" | "retrieve">;

export type TriggerMicrovmReleaseConfig = {
  accessToken: string;
  projectRef: string;
  variables: Record<TriggerMicrovmReleaseEnvName, string>;
};

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function getTriggerMicrovmReleaseConfig(
  env: NodeJS.ProcessEnv,
): TriggerMicrovmReleaseConfig {
  const rawManifest = required(env, "AWS_LAMBDA_MICROVM_RELEASE_MANIFEST");
  const manifest = parseAwsLambdaMicrovmReleaseManifest(rawManifest);
  const east = manifest.regions["us-east-1"];
  return {
    accessToken: required(env, "TRIGGER_ACCESS_TOKEN"),
    projectRef: required(env, "TRIGGER_PROJECT_ID"),
    variables: {
      AWS_LAMBDA_MICROVM_RELEASE_MANIFEST: JSON.stringify(manifest),
      AWS_LAMBDA_MICROVM_IMAGE_ID: east.imageIdentifier,
      AWS_LAMBDA_MICROVM_IMAGE_VERSION: east.imageVersion,
      AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN: east.executionRoleArn,
    },
  };
}

export async function syncAndVerifyTriggerMicrovmReleaseEnv({
  client,
  config,
}: {
  client: TriggerEnvClient;
  config: TriggerMicrovmReleaseConfig;
}): Promise<void> {
  const upload = await client.upload(
    config.projectRef,
    TRIGGER_MICROVM_RELEASE_ENVIRONMENT,
    {
      variables: config.variables,
      override: true,
    },
  );
  if (!upload.success) {
    throw new Error(
      "Trigger.dev did not confirm the environment variable upload",
    );
  }

  for (const name of TRIGGER_MICROVM_RELEASE_ENV_NAMES) {
    const stored = await client.retrieve(
      config.projectRef,
      TRIGGER_MICROVM_RELEASE_ENVIRONMENT,
      name,
    );
    if (stored.isSecret || stored.value !== config.variables[name]) {
      throw new Error(
        `Trigger.dev stored value verification failed for ${name}`,
      );
    }
  }
}
