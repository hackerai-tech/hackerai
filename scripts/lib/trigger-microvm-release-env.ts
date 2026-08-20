export const TRIGGER_MICROVM_RELEASE_ENVIRONMENT = "prod" as const;

export const TRIGGER_MICROVM_RELEASE_ENV_NAMES = [
  "CLOUD_SANDBOX_PROVIDER",
  "AWS_LAMBDA_MICROVM_IMAGE_ID",
  "AWS_LAMBDA_MICROVM_IMAGE_VERSION",
  "AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
] as const;

type TriggerMicrovmReleaseEnvName =
  (typeof TRIGGER_MICROVM_RELEASE_ENV_NAMES)[number];

type TriggerEnvClient = {
  upload: (
    projectRef: string,
    environment: typeof TRIGGER_MICROVM_RELEASE_ENVIRONMENT,
    params: {
      variables: Record<TriggerMicrovmReleaseEnvName, string>;
      override: true;
    },
  ) => Promise<{ success: boolean }>;
  retrieve: (
    projectRef: string,
    environment: typeof TRIGGER_MICROVM_RELEASE_ENVIRONMENT,
    name: TriggerMicrovmReleaseEnvName,
  ) => Promise<{ name: string; value: string; isSecret: boolean }>;
};

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
  return {
    accessToken: required(env, "TRIGGER_ACCESS_TOKEN"),
    projectRef: required(env, "TRIGGER_PROJECT_ID"),
    variables: {
      CLOUD_SANDBOX_PROVIDER: "aws-lambda-microvm",
      AWS_LAMBDA_MICROVM_IMAGE_ID: required(env, "AWS_LAMBDA_MICROVM_IMAGE_ID"),
      AWS_LAMBDA_MICROVM_IMAGE_VERSION: required(
        env,
        "AWS_LAMBDA_MICROVM_IMAGE_VERSION",
      ),
      AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN: required(
        env,
        "AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
      ),
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
