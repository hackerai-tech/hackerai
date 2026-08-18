import {
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";

const region = "us-east-1";
const imageIdentifier = process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
const imageVersion = process.env.AWS_LAMBDA_MICROVM_IMAGE_VERSION;
const executionRoleArn = process.env.AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN;
const logGroup =
  process.env.AWS_LAMBDA_MICROVM_LOG_GROUP ||
  "/aws/lambda/microvms/hackerai-cloud-agent";

if (!imageIdentifier || !imageVersion || !executionRoleArn) {
  throw new Error(
    "AWS_LAMBDA_MICROVM_IMAGE_ID, AWS_LAMBDA_MICROVM_IMAGE_VERSION, and AWS_LAMBDA_MICROVM_EXECUTION_ROLE_ARN are required",
  );
}

const ingressConnector = `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:NO_INGRESS`;
const egressConnector = `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;
const client = new LambdaMicrovmsClient({ region, maxAttempts: 4 });
const sleep = (durationMs) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));

async function waitForState(microvmId, expectedState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let microvm;
  while (Date.now() < deadline) {
    microvm = await client.send(
      new GetMicrovmCommand({ microvmIdentifier: microvmId }),
    );
    if (microvm.state === expectedState) return microvm;
    if (microvm.state === "TERMINATED" && expectedState !== "TERMINATED") {
      throw new Error(
        `Smoke-test MicroVM terminated before becoming ${expectedState}: ${microvm.stateReason || "no reason returned"}`,
      );
    }
    await sleep(5_000);
  }
  throw new Error(
    `Timed out waiting for smoke-test MicroVM to become ${expectedState}; last state was ${microvm?.state || "unknown"}`,
  );
}

let microvmId;
let failure;
try {
  const response = await client.send(
    new RunMicrovmCommand({
      imageIdentifier,
      imageVersion,
      executionRoleArn,
      ingressNetworkConnectors: [ingressConnector],
      egressNetworkConnectors: [egressConnector],
      logging: { cloudWatch: { logGroup } },
      maximumDurationInSeconds: 300,
      clientToken: crypto.randomUUID(),
      runHookPayload: JSON.stringify({ smokeTest: true }),
    }),
  );
  microvmId = response.microvmId;
  if (!microvmId) throw new Error("AWS did not return a smoke-test MicroVM ID");

  const microvm = await waitForState(microvmId, "RUNNING", 5 * 60 * 1000);
  if (microvm.imageVersion !== imageVersion) {
    throw new Error(
      `Smoke-test MicroVM used image version ${microvm.imageVersion || "unknown"}, expected ${imageVersion}`,
    );
  }
  console.log(
    `MicroVM image ${imageIdentifier} version ${imageVersion} launched successfully as ${microvmId}`,
  );
} catch (error) {
  failure = error;
} finally {
  if (microvmId) {
    try {
      await client.send(
        new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
      );
      await waitForState(microvmId, "TERMINATED", 5 * 60 * 1000);
      console.log(`Smoke-test MicroVM ${microvmId} terminated successfully`);
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            "MicroVM smoke test failed and cleanup could not be confirmed",
          )
        : cleanupError;
    }
  }
}

if (failure) throw failure;
