import type { envvars } from "@trigger.dev/sdk";

export const TRIGGER_CLOUD_SANDBOX_ENVIRONMENT = "prod" as const;
export const CLOUD_SANDBOX_PROVIDERS = ["e2b", "aws-lambda-microvm"] as const;

export type CloudSandboxProvider = (typeof CLOUD_SANDBOX_PROVIDERS)[number];

type TriggerEnvClient = Pick<typeof envvars, "upload" | "retrieve">;

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function getTriggerCloudSandboxProviderConfig(env: NodeJS.ProcessEnv) {
  const provider = required(env, "CLOUD_SANDBOX_PROVIDER");
  if (!CLOUD_SANDBOX_PROVIDERS.includes(provider as CloudSandboxProvider)) {
    throw new Error(`Unsupported CLOUD_SANDBOX_PROVIDER: ${provider}`);
  }

  return {
    accessToken: required(env, "TRIGGER_ACCESS_TOKEN"),
    projectRef: required(env, "TRIGGER_PROJECT_ID"),
    provider: provider as CloudSandboxProvider,
  };
}

export async function setAndVerifyTriggerCloudSandboxProvider({
  client,
  projectRef,
  provider,
}: {
  client: TriggerEnvClient;
  projectRef: string;
  provider: CloudSandboxProvider;
}) {
  const upload = await client.upload(
    projectRef,
    TRIGGER_CLOUD_SANDBOX_ENVIRONMENT,
    {
      variables: { CLOUD_SANDBOX_PROVIDER: provider },
      override: true,
    },
  );
  if (!upload.success) {
    throw new Error("Trigger.dev did not confirm the provider update");
  }

  const stored = await client.retrieve(
    projectRef,
    TRIGGER_CLOUD_SANDBOX_ENVIRONMENT,
    "CLOUD_SANDBOX_PROVIDER",
  );
  if (stored.isSecret || stored.value !== provider) {
    throw new Error("Trigger.dev provider read-back verification failed");
  }
}
