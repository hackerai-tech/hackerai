import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(root, ".artifacts", "aws-lambda-microvm");
const outputPath = join(outputDir, "hackerai-lambda-microvm.zip");
const baseDockerfile = await readFile(
  join(root, "docker", "Dockerfile"),
  "utf8",
);
const localPackage = JSON.parse(
  await readFile(join(root, "packages", "local", "package.json"), "utf8"),
);

// Keep dependency categories identical to the package-specific lockfile so
// frozen installs remain reproducible. `--prod` skips devDependencies while
// retaining optional node-pty for managed-cloud PTY support.
delete localPackage.scripts;

const dockerfile = `${baseDockerfile.trim()}

# Lambda MicroVM egress exposes an AWS link-local resolver that ProjectDiscovery
# tools do not discover automatically. Keep explicit user resolver flags intact.
COPY aws/naabu /usr/local/bin/naabu
RUN chmod 0755 /usr/local/bin/naabu

# AWS Lambda MicroVM lifecycle and command relay agent
COPY agent/package.json /opt/hackerai-cloud-agent/package.json
COPY agent/pnpm-lock.yaml /opt/hackerai-cloud-agent/pnpm-lock.yaml
COPY agent/dist /opt/hackerai-cloud-agent/dist
RUN npm install --global --no-audit --no-fund pnpm@10.32.1 && \\
    cd /opt/hackerai-cloud-agent && \\
    pnpm install --prod --frozen-lockfile && \\
    npm cache clean --force && \\
    pnpm store prune
EXPOSE 8080
ENTRYPOINT ["node", "/opt/hackerai-cloud-agent/dist/index.js", "--cloud-lifecycle"]
`;

const zip = new JSZip();
zip.file("Dockerfile", dockerfile);
zip.file(
  "aws/naabu",
  await readFile(join(root, "aws-lambda-microvm", "naabu")),
);
zip.file("agent/package.json", `${JSON.stringify(localPackage, null, 2)}\n`);
zip.file(
  "agent/pnpm-lock.yaml",
  await readFile(join(root, "packages", "local", "pnpm-lock.yaml")),
);

async function addDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await addDirectory(path);
    else if (entry.isFile()) {
      zip.file(
        `agent/dist/${relative(join(root, "packages", "local", "dist"), path)}`,
        await readFile(path),
      );
    }
  }
}

await addDirectory(join(root, "packages", "local", "dist"));
await mkdir(outputDir, { recursive: true });
await writeFile(
  outputPath,
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(outputPath);
