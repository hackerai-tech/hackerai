import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
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
const imageVersion = response.imageVersion;
if (!imageVersion) {
  throw new Error("AWS did not return the published MicroVM image version");
}

const deadline = Date.now() + 45 * 60 * 1000;
let version;
while (Date.now() < deadline) {
  version = await lambda.send(
    new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }),
  );
  if (version.state === "SUCCESSFUL" && version.status === "ACTIVE") break;
  if (version.state === "FAILED") {
    throw new Error(
      `MicroVM image version ${imageVersion} failed: ${version.stateReason || "no reason returned"}`,
    );
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
}
if (version?.state !== "SUCCESSFUL" || version.status !== "ACTIVE") {
  throw new Error(
    `Timed out waiting for MicroVM image version ${imageVersion} to become active`,
  );
}

const output = [
  `AWS_LAMBDA_MICROVM_IMAGE_ID=${version.imageArn || imageIdentifier}`,
  `AWS_LAMBDA_MICROVM_IMAGE_VERSION=${imageVersion}`,
].join("\n");

if (process.env.AWS_LAMBDA_MICROVM_OUTPUT_FILE) {
  await writeFile(
    resolve(process.env.AWS_LAMBDA_MICROVM_OUTPUT_FILE),
    `${output}\n`,
    { mode: 0o600 },
  );
}

console.log(output);
