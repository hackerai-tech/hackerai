import { readFile, writeFile, chmod, chown } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

const adminKey = (
  await readFile("/run/private/convex-admin-key", "utf8")
).trim();
const backend = process.env.CONVEX_SELF_HOSTED_URL ?? "http://backend:3210";
if (process.argv[2] === "env") {
  const names = [
    "SELF_HOSTED_AUTH_ISSUER",
    "CONVEX_SERVICE_ROLE_KEY",
    "CONVEX_USER_RESEARCH_SERVICE_KEY",
    "CENTRIFUGO_TOKEN_SECRET",
    "CENTRIFUGO_WS_URL",
    "AWS_S3_ACCESS_KEY_ID",
    "AWS_S3_SECRET_ACCESS_KEY",
    "AWS_S3_REGION",
    "AWS_S3_BUCKET_NAME",
    "S3_ENDPOINT_URL",
    "S3_REGIONAL_STORAGE_ENABLED",
    "NEXT_PUBLIC_SELF_HOSTED",
  ];
  const response = await fetch(`${backend}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changes: names.map((name) => ({ name, value: process.env[name] })),
    }),
  });
  if (!response.ok)
    throw new Error(`Falha ao configurar o backend: HTTP ${response.status}`);
  console.log("Variáveis do backend configuradas.");
} else if (process.argv[2] === "deploy") {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("pnpm", ["exec", "convex", "deploy", "--yes"], {
    stdio: "inherit",
    env: { ...process.env, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey },
  });
  process.exitCode = result.status ?? 1;
} else if (process.argv[2] === "sandbox") {
  const client = new ConvexHttpClient(backend);
  const issuer = process.env.SELF_HOSTED_AUTH_ISSUER;
  const subject = process.env.LOCAL_AUTH_USER_ID;
  client.setAdminAuth(adminKey, {
    issuer,
    subject,
    tokenIdentifier: `${issuer}|${subject}`,
    email: process.env.LOCAL_AUTH_EMAIL,
  });
  const { token } = await client.mutation("localSandbox:getToken", {});
  const path = "/run/private/sandbox-token";
  await writeFile(path, token, { mode: 0o400 });
  await chmod(path, 0o400);
  await chown(path, 1000, 1000);
  console.log("Credencial privada do sandbox preparada.");
} else if (process.argv[2] === "storage") {
  const s3 = new S3Client({
    endpoint: "http://storage:9000",
    region: process.env.AWS_S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY,
    },
  });
  try {
    await s3.send(
      new HeadBucketCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME }),
    );
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await s3.send(
      new CreateBucketCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME }),
    );
  }
  console.log("Armazenamento privado preparado.");
} else throw new Error("Operação desconhecida.");
