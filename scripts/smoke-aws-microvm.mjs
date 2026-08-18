import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import WebSocket from "ws";

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

const ingressConnector = `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
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

async function runDirectCommand(microvm) {
  if (!microvm.microvmId || !microvm.endpoint) {
    throw new Error("Running smoke-test MicroVM has no endpoint");
  }
  const tokenResponse = await client.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvm.microvmId,
      expirationInMinutes: 5,
      allowedPorts: [{ port: 9000 }],
    }),
  );
  const token = tokenResponse.authToken?.["X-aws-proxy-auth"];
  if (!token) throw new Error("AWS did not return a MicroVM auth token");

  const endpoint = new URL(
    microvm.endpoint.includes("://")
      ? microvm.endpoint
      : `https://${microvm.endpoint}`,
  );
  endpoint.protocol = "wss:";
  endpoint.pathname = "/sandbox";
  const socket = new WebSocket(endpoint, [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    "lambda-microvms.port.9000",
  ]);
  const commandId = crypto.randomUUID();
  let stdout = "";

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let commandSent = false;
      const timeout = setTimeout(() => {
        finish(
          new Error("Direct WebSocket command timed out after 30 seconds"),
        );
      }, 30_000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners("error");
        socket.removeAllListeners("message");
        if (error) reject(error);
        else resolve();
      };
      socket.on("error", finish);
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.type === "transport_ready" && !commandSent) {
          commandSent = true;
          socket.send(
            JSON.stringify({
              type: "command",
              commandId,
              command: "printf hackerai-direct-smoke",
              timeout: 10_000,
              displayName: "",
              targetConnectionId: microvm.microvmId,
            }),
          );
          return;
        }
        if (message.commandId !== commandId) return;
        if (message.type === "stdout") stdout += message.data;
        if (message.type === "error") {
          finish(new Error(`Direct command failed: ${message.message}`));
        }
        if (message.type === "exit") {
          if (message.exitCode !== 0 || stdout !== "hackerai-direct-smoke") {
            finish(
              new Error(
                `Direct command returned exit=${message.exitCode} stdout=${JSON.stringify(stdout)}`,
              ),
            );
          } else {
            finish();
          }
        }
      });
    });
  } finally {
    socket.close();
  }
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
      idlePolicy: {
        maxIdleDurationSeconds: 300,
        suspendedDurationSeconds: 1800,
        autoResumeEnabled: true,
      },
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
  await runDirectCommand(microvm);
  console.log(
    `MicroVM image ${imageIdentifier} version ${imageVersion} passed its authenticated direct-command smoke test as ${microvmId}`,
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
