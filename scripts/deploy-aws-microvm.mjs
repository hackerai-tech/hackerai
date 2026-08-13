import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  UpdateMicrovmImageCommand,
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  root,
  ".artifacts/aws-lambda-microvm/hackerai-lambda-microvm.zip",
);
const region =
  process.env.AWS_LAMBDA_MICROVM_REGION ||
  process.env.AWS_REGION ||
  "us-east-1";
const bucket = process.env.AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET;
const buildRoleArn = process.env.AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN;
const name =
  process.env.AWS_LAMBDA_MICROVM_IMAGE_NAME || "hackerai-cloud-agent";
const baseImageArn =
  process.env.AWS_LAMBDA_MICROVM_BASE_IMAGE_ARN ||
  `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;

if (!bucket || !buildRoleArn) {
  throw new Error(
    "AWS_LAMBDA_MICROVM_ARTIFACT_BUCKET and AWS_LAMBDA_MICROVM_BUILD_ROLE_ARN are required",
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
  resources: [{ minimumMemoryInMiB: 2048 }],
  additionalOsCapabilities: ["ALL"],
  hooks: {
    port: 8080,
    microvmHooks: {
      run: "ENABLED",
      runTimeoutInSeconds: 90,
      resume: "ENABLED",
      resumeTimeoutInSeconds: 60,
      suspend: "ENABLED",
      suspendTimeoutInSeconds: 30,
      terminate: "ENABLED",
      terminateTimeoutInSeconds: 30,
    },
    microvmImageHooks: {
      ready: "ENABLED",
      readyTimeoutInSeconds: 30,
      validate: "ENABLED",
      validateTimeoutInSeconds: 30,
    },
  },
  tags: { application: "hackerai", component: "cloud-sandbox" },
};

let existing = null;
try {
  existing = await lambda.send(
    new GetMicrovmImageCommand({ imageIdentifier: name }),
  );
} catch (error) {
  if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") {
    throw error;
  }
}

const response = existing
  ? await lambda.send(
      new UpdateMicrovmImageCommand({
        ...common,
        imageIdentifier: existing.imageArn || name,
        clientToken: crypto.randomUUID(),
      }),
    )
  : await lambda.send(
      new CreateMicrovmImageCommand({
        ...common,
        name,
        clientToken: crypto.randomUUID(),
      }),
    );

const imageIdentifier = response.imageArn || name;
const deadline = Date.now() + 45 * 60 * 1000;
let image = response;
while (Date.now() < deadline) {
  image = await lambda.send(new GetMicrovmImageCommand({ imageIdentifier }));
  if (image.state === "CREATED" || image.state === "UPDATED") break;
  if (image.state?.endsWith("FAILED")) {
    throw new Error(`MicroVM image build failed with state ${image.state}`);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
}
if (image.state !== "CREATED" && image.state !== "UPDATED") {
  throw new Error("Timed out waiting for the MicroVM image build");
}

console.log(`AWS_LAMBDA_MICROVM_IMAGE_ID=${image.imageArn || imageIdentifier}`);
console.log(
  `AWS_LAMBDA_MICROVM_IMAGE_VERSION=${image.latestActiveImageVersion || ""}`,
);
