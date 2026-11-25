// Run with pnpm exec tsx e2e/offline-workspace/serve.mjs [docker-context].
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  workspaceReaderCommand,
  workspaceRequest,
} from "../../lib/sandbox/workspace-files.ts";

const execute = promisify(execFile);
const requireModule = createRequire(import.meta.url);
// Reuse the same installed bundler as the Markdown browser fixtures.
const esbuild = createRequire(requireModule.resolve("tsx/package.json"))(
  "esbuild",
);
const dockerContext = process.argv[2];
const host = "127.0.0.1";
const status = { state: "running", sandboxId: "offline-qa" };
const proxyVariables = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
];
const fixtures = {
  "inventory.csv": 'item,quantity\n"notebook, blue",2\npen,4\n',
  "inventory.md": "# Workshop inventory\n\nTwo **blue notebooks** are ready.\n",
  "hours.html": "<h1>Workshop hours</h1><p>Open at nine.</p>",
};
// The live panel runs without a signed-in app shell or saved chat data.
const fixtureImports = {
  "../contexts/GlobalState":
    "export function useGlobalState() { throw new Error('App shell is unavailable in workspace QA'); }",
  "./ChatFilesPanel":
    "export function ChatFilesPanel() { throw new Error('Saved chat files are unavailable in workspace QA'); }",
  "./AllFilesDialog":
    "export function AllFilesDialog() { throw new Error('Saved chat files are unavailable in workspace QA'); }",
  "@/lib/analytics/workspace-files":
    "export const telemetryNow = () => performance.now(); export const elapsedMs = (start) => performance.now() - start; export function trackWorkspaceFiles() {}",
};

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline workspace QA</title>
<div id="root"></div>
<script src="/fixture.js" defer></script>
`;

async function serve() {
  // The workspace lives under the checkout so Linux Docker VMs can bind it.
  const cache = fileURLToPath(
    new URL("../../node_modules/.cache/", import.meta.url),
  );
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, "offline-workspace-"));
  try {
    const workspace = join(temporary, "workspace");
    const reports = join(workspace, "reports");
    await mkdir(reports, { recursive: true, mode: 0o755 });
    await Promise.all(
      Object.entries(fixtures).map(([name, content]) =>
        writeFile(join(reports, name), content),
      ),
    );

    const containerArgs = [
      ...(dockerContext ? ["--context", dockerContext] : []),
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65534:65534",
      "--mount",
      `type=bind,source=${workspace},target=/workspace,readonly`,
      // Docker client proxy defaults can inject variables into new containers.
      ...proxyVariables.flatMap((key) => [
        "--env",
        `${key}=`,
        "--env",
        `${key.toLowerCase()}=`,
      ]),
      "node:22-bookworm",
    ];
    const run = (...command) =>
      execute("docker", [...containerArgs, ...command], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      });
    await run(
      "python3",
      "-I",
      "-c",
      "import os, socket; assert {name for _, name in socket.if_nameindex()} == {'lo'}; assert not any(value for key, value in os.environ.items() if key.lower().endswith('_proxy'))",
    );

    const bundle = await esbuild.build({
      entryPoints: [fileURLToPath(new URL("./fixture.tsx", import.meta.url))],
      bundle: true,
      write: false,
      jsx: "automatic",
      platform: "browser",
      define: {
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.env": "{}",
      },
      plugins: [
        {
          name: "offline-workspace-fixture",
          setup(build) {
            build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
              if (
                importer.endsWith("/WorkspaceFilesPanel.tsx") &&
                Object.hasOwn(fixtureImports, path)
              )
                return { path, namespace: "offline-workspace-fixture" };
            });
            build.onLoad(
              { filter: /.*/, namespace: "offline-workspace-fixture" },
              ({ path }) => ({
                contents: fixtureImports[path],
              }),
            );
          },
        },
      ],
    });
    const javascript = bundle.outputFiles[0].contents;

    async function readWorkspace(request) {
      const parsed = workspaceRequest.safeParse(
        JSON.parse(await text(request)),
      );
      if (!parsed.success) return { error: "invalid_request" };
      const input = parsed.data;
      if (
        input.chatId !== status.sandboxId ||
        (input.sandboxId && input.sandboxId !== status.sandboxId) ||
        !["list", "preview", "download"].includes(input.action)
      ) {
        return { error: "invalid_request" };
      }
      // The browser supplies a file request, never a shell command.
      const { stdout } = await run(
        "sh",
        "-c",
        workspaceReaderCommand(input, "/workspace"),
      );
      return { ...status, ...JSON.parse(stdout) };
    }

    const server = createServer(async (request, response) => {
      if (
        request.method === "GET" &&
        (request.url === "/" || request.url === "/fixture.js")
      ) {
        const script = request.url === "/fixture.js";
        response.writeHead(200, {
          "Content-Type": script
            ? "text/javascript"
            : "text/html; charset=utf-8",
          "Content-Security-Policy":
            "connect-src 'self'; form-action 'none'; object-src 'none'; base-uri 'none'",
        });
        response.end(script ? javascript : html);
        return;
      }
      if (request.method !== "POST" || request.url !== "/api/workspace-files") {
        response.writeHead(404).end();
        return;
      }
      const address = server.address();
      if (
        typeof address !== "object" ||
        !address ||
        request.headers.origin !== `http://${host}:${address.port}`
      ) {
        response.writeHead(403).end();
        return;
      }
      try {
        const result = await readWorkspace(request);
        response.writeHead(result.error ? 400 : 200, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unavailable" }));
      }
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        if (address && typeof address === "object")
          console.log(`Offline workspace QA at http://${host}:${address.port}`);
      });
      server.once("close", resolve);
      const stop = () => server.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

serve().catch((error) => {
  console.error(error instanceof Error ? error.message : "Workspace QA failed");
  process.exitCode = 1;
});
