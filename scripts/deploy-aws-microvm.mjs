import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListMicrovmImageBuildsCommand,
  paginateListMicrovmImages,
  UpdateMicrovmImageCommand,
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  root,
  ".artifacts/aws-lambda-microvm/hackerai-lambda-microvm.zip",
);
const region =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const bucket = process.env.AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET;
const buildRoleArn = process.env.AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN;
const executionRoleArn =
  process.env.AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN?.trim();
const name =
  process.env.AWS_LAMBDA_MICROVM_IMAGE_NAME || "hackerai-cloud-agent";
const baseImageArn =
  process.env.AWS_LAMBDA_MICROVM_BASE_IMAGE_ARN ||
  `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
const publishAttempts = Number.parseInt(
  process.env.AWS_LAMBDA_MICROVM_PUBLISH_ATTEMPTS || "2",
  10,
);
const retrySignalFile = process.env.AWS_LAMBDA_MICROVM_RETRY_SIGNAL_FILE;
const releaseRequestId = [
  process.env.GITHUB_RUN_ID,
  process.env.GITHUB_RUN_ATTEMPT,
]
  .filter(Boolean)
  .join(":");
const releaseEnvironment =
  process.env.GITHUB_ACTIONS === "true" ? "prod" : "local";

function releaseLog(level, event, properties) {
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    request_id: releaseRequestId || "unavailable",
    service: "aws-microvm-release",
    environment: releaseEnvironment,
    ...properties,
  });
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

if (!bucket || !buildRoleArn || !executionRoleArn) {
  throw new Error(
    "AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET, AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN, and AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN are required",
  );
}
if (
  !Number.isSafeInteger(publishAttempts) ||
  publishAttempts < 1 ||
  publishAttempts > 3
) {
  throw new Error(
    "AWS_LAMBDA_MICROVM_PUBLISH_ATTEMPTS must be an integer from 1 through 3",
  );
}

const key = `hackerai-lambda-microvm/${Date.now()}.zip`;
const body = await readFile(artifactPath);
await new S3Client({ region }).send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/zip",
    ServerSideEncryption: "AES256",
  }),
);

const lambda = new LambdaMicrovmsClient({ region, maxAttempts: 4 });

async function resolveBuildFailure(imageIdentifier, imageVersion) {
  try {
    const response = await lambda.send(
      new ListMicrovmImageBuildsCommand({
        imageIdentifier,
        imageVersion,
        maxResults: 25,
      }),
    );
    const builds = (response.items || []).map((build) => ({
      build_id: build.buildId,
      build_state: build.buildState,
      architecture: build.architecture,
      state_reason: build.stateReason?.trim() || null,
    }));
    const stateReason = builds.find(
      (build) =>
        build.build_state === "FAILED" &&
        build.architecture === "ARM_64" &&
        build.state_reason,
    )?.state_reason;
    return { builds, stateReason: stateReason || null };
  } catch (error) {
    releaseLog("warn", "aws_microvm_image_build_diagnostics_failed", {
      region,
      image_identifier: imageIdentifier,
      image_version: imageVersion,
      error_name: error?.name || "Error",
      error_message: error?.message || String(error),
    });
    return { builds: [], stateReason: null };
  }
}

const common = {
  baseImageArn,
  buildRoleArn,
  description: "HackerAI isolated Cloud Agent with native-network capability",
  codeArtifact: { uri: `s3://${bucket}/${key}` },
  logging: {
    cloudWatch: { logGroup: "/aws/lambda/microvms/hackerai-cloud-agent" },
  },
  egressNetworkConnectors: [
    `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
  ],
  cpuConfigurations: [{ architecture: "ARM_64" }],
  resources: [{ minimumMemoryInMiB: 4096 }],
  additionalOsCapabilities: ["ALL"],
  hooks: {
    port: 8080,
    microvmHooks: {
      run: "ENABLED",
      runTimeoutInSeconds: 60,
      resume: "ENABLED",
      resumeTimeoutInSeconds: 60,
      suspend: "ENABLED",
      suspendTimeoutInSeconds: 30,
      terminate: "ENABLED",
      terminateTimeoutInSeconds: 30,
    },
    microvmImageHooks: {
      ready: "ENABLED",
      readyTimeoutInSeconds: 60,
      validate: "ENABLED",
      validateTimeoutInSeconds: 30,
    },
  },
  tags: { application: "hackerai", component: "cloud-sandbox" },
};

let existing = null;
for await (const page of paginateListMicrovmImages(
  { client: lambda },
  { nameFilter: name },
)) {
  existing = page.items?.find((image) => image.name === name) || null;
  if (existing) {
    break;
  }
}

let imageIdentifier = existing?.imageArn || name;
let imageVersion;
let version;

async function sendPublishCommand({ attempt, input, update }) {
  const blockedDeadline = Date.now() + 45 * 60 * 1000;
  let blockedAt;

  while (true) {
    try {
      const response = await lambda.send(
        update
          ? new UpdateMicrovmImageCommand(input)
          : new CreateMicrovmImageCommand(input),
      );
      if (blockedAt !== undefined) {
        releaseLog("info", "aws_microvm_image_publish_unblocked", {
          region,
          image_identifier: imageIdentifier,
          attempt,
          max_attempts: publishAttempts,
          blocked_duration_ms: Date.now() - blockedAt,
        });
      }
      return response;
    } catch (error) {
      const blocked =
        update &&
        error?.name === "ValidationException" &&
        error.message?.includes(
          "Cannot update MicroVM Image in its current state",
        );
      if (!blocked || Date.now() >= blockedDeadline) throw error;
      if (blockedAt === undefined) {
        blockedAt = Date.now();
        releaseLog("warn", "aws_microvm_image_publish_blocked", {
          region,
          image_identifier: imageIdentifier,
          attempt,
          max_attempts: publishAttempts,
          error_name: error.name,
          retry_interval_ms: 30_000,
        });
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30_000));
    }
  }
}

publish: for (let attempt = 1; attempt <= publishAttempts; attempt += 1) {
  const update = Boolean(existing || attempt > 1);
  const response = await sendPublishCommand({
    attempt,
    update,
    input: update
      ? {
          ...common,
          imageIdentifier,
          clientToken: crypto.randomUUID(),
        }
      : {
          ...common,
          name,
          clientToken: crypto.randomUUID(),
        },
  });

  imageIdentifier = response.imageArn || imageIdentifier;
  imageVersion = response.imageVersion;
  if (!imageVersion) {
    throw new Error("AWS did not return the published MicroVM image version");
  }

  releaseLog("info", "aws_microvm_image_publish_started", {
    region,
    image_identifier: imageIdentifier,
    image_version: imageVersion,
    attempt,
    max_attempts: publishAttempts,
  });

  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    version = await lambda.send(
      new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }),
    );
    if (version.state === "SUCCESSFUL" && version.status === "ACTIVE") {
      releaseLog("info", "aws_microvm_image_publish_succeeded", {
        region,
        image_identifier: imageIdentifier,
        image_version: imageVersion,
        attempt,
        max_attempts: publishAttempts,
        state: version.state,
        status: version.status,
      });
      break publish;
    }
    if (version.state === "FAILED") {
      const buildFailure = await resolveBuildFailure(
        imageIdentifier,
        imageVersion,
      );
      const stateReason =
        version.stateReason?.trim() || buildFailure.stateReason || null;
      const retrying = stateReason === null && attempt < publishAttempts;
      const delegatingRetry =
        stateReason === null && !retrying && Boolean(retrySignalFile);
      releaseLog(
        retrying || delegatingRetry ? "warn" : "error",
        "aws_microvm_image_publish_failed",
        {
          region,
          image_identifier: imageIdentifier,
          image_version: imageVersion,
          attempt,
          max_attempts: publishAttempts,
          state: version.state,
          status: version.status,
          state_reason: stateReason,
          builds: buildFailure.builds,
          retry_scheduled: retrying || delegatingRetry,
          retry_delegated: delegatingRetry,
        },
      );
      if (retrying) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 10_000),
        );
        continue publish;
      }
      if (delegatingRetry) {
        await writeFile(resolve(retrySignalFile), "retry\n", { mode: 0o600 });
      }
      throw new Error(
        `MicroVM image version ${imageVersion} failed: ${stateReason || "no reason returned"}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  }

  throw new Error(
    `Timed out waiting for MicroVM image version ${imageVersion} to become active`,
  );
}

if (
  !imageVersion ||
  version?.state !== "SUCCESSFUL" ||
  version.status !== "ACTIVE"
) {
  throw new Error("AWS did not publish an active MicroVM image version");
}

const output = [
  `AWS_REGION=${region}`,
  `AWS_LAMBDA_MICROVM_IMAGE_ID=${version.imageArn || imageIdentifier}`,
  `AWS_LAMBDA_MICROVM_IMAGE_VERSION=${imageVersion}`,
  `AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN=${executionRoleArn}`,
].join("\n");

if (process.env.AWS_LAMBDA_MICROVM_OUTPUT_FILE) {
  await writeFile(
    resolve(process.env.AWS_LAMBDA_MICROVM_OUTPUT_FILE),
    `${output}\n`,
    { mode: 0o600 },
  );
}

console.log(output);
