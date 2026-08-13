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

// node-pty is optional for user-owned hosts, but it is required in the managed
// cloud image because interactive terminal parity is part of the provider gate.
localPackage.dependencies = {
  ...localPackage.dependencies,
  ...localPackage.optionalDependencies,
};
delete localPackage.optionalDependencies;
delete localPackage.devDependencies;
delete localPackage.scripts;

const dockerfile = `${baseDockerfile.trim()}

# AWS Lambda MicroVM lifecycle and command relay agent
COPY agent/package.json /opt/hackerai-cloud-agent/package.json
COPY agent/dist /opt/hackerai-cloud-agent/dist
RUN cd /opt/hackerai-cloud-agent && npm install --omit=dev --no-audit --no-fund && npm cache clean --force
EXPOSE 8080
ENTRYPOINT ["node", "/opt/hackerai-cloud-agent/dist/index.js", "--cloud-lifecycle"]
`;

const zip = new JSZip();
zip.file("Dockerfile", dockerfile);
zip.file("agent/package.json", `${JSON.stringify(localPackage, null, 2)}\n`);

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
