import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(root, ".github/scripts/prefer-ubuntu-apt-mirror.sh");
const mirrorSource = "mirror+file:/etc/apt/apt-mirrors.txt";
const ubuntuKeyring = "/usr/share/keyrings/ubuntu-archive-keyring.gpg";
// The independent HTTPS replica comes first; Canonical hosts stay as fallbacks.
const x64Mirrors = [
  "https://packages.hetzner.com/ubuntu/packages/",
  "https://archive.ubuntu.com/ubuntu/",
  "http://azure.archive.ubuntu.com/ubuntu/",
  "https://security.ubuntu.com/ubuntu/",
];
const arm64Mirrors = [
  "https://packages.hetzner.com/ubuntu-ports/packages/",
  "http://ports.ubuntu.com/ubuntu-ports/",
];

function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "ubuntu-apt-mirror-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "etc/apt/sources.list.d"), { recursive: true });
  mkdirSync(join(dir, "etc/apt/apt.conf.d"), { recursive: true });
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(dir, path), content);
  return dir;
}

/** Read every file below the fixture's APT directory, keyed by relative path. */
function snapshot(dir) {
  const files = {};
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else files[relative(dir, child)] = readFileSync(child, "utf8");
    }
  };
  walk(join(dir, "etc/apt"));
  return files;
}

/** Run the helper against the fixture and return the resulting APT files. */
function prefer(dir, arch) {
  const result = spawnSync("bash", [script], {
    env: { ...process.env, APT_MIRROR_ROOT: dir, RUNNER_ARCH: arch },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const files = snapshot(dir);
  for (const [path, content] of Object.entries(files))
    assert.doesNotMatch(
      content,
      /trusted=yes|allow-insecure|Verify-Peer|AllowUnauthenticated/i,
      path,
    );
  return files;
}

/** Mirror URLs in the order APT tries them. */
function mirrors(files) {
  const list = files["etc/apt/apt-mirrors.txt"];
  assert.ok(list, "Ubuntu sources need a mirror list");
  return list
    .trim()
    .split("\n")
    .map((line) => {
      const [url, priority] = line.split("\t");
      return { url, priority: Number(priority.replace(/^priority:/, "")) };
    })
    .sort((a, b) => a.priority - b.priority)
    .map(({ url }) => url);
}

test("x64 legacy runner sources prefer the HTTPS replica before Canonical", (t) => {
  const sources = [
    `deb ${mirrorSource} jammy main restricted`,
    `deb ${mirrorSource} jammy-updates main restricted universe multiverse`,
    `deb ${mirrorSource} jammy-security main restricted`,
    // Cross-architecture ports are not served by the x64 replica.
    "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports jammy main",
    "",
  ].join("\n");
  const ppa =
    "deb [arch=amd64 signed-by=/etc/apt/keyrings/git.gpg] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu jammy main\n";
  const dir = fixture(t, {
    "etc/apt/apt-mirrors.txt": [
      "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
      "https://archive.ubuntu.com/ubuntu/\tpriority:2",
      "https://security.ubuntu.com/ubuntu/\tpriority:3",
      "",
    ].join("\n"),
    "etc/apt/sources.list": sources,
    "etc/apt/sources.list.d/git-core.list": ppa,
  });

  const files = prefer(dir, "X64");

  assert.deepEqual(mirrors(files), x64Mirrors);
  assert.equal(files["etc/apt/sources.list"], sources);
  assert.equal(files["etc/apt/sources.list.d/git-core.list"], ppa);
});

test("x64 Deb822 sources route Canonical URIs through the mirror list with signatures intact", (t) => {
  const stanza = (uri, suites) =>
    [
      "Types: deb",
      `URIs: ${uri}`,
      `Suites: ${suites}`,
      "Components: main universe restricted multiverse",
      `Signed-By: ${ubuntuKeyring}`,
    ].join("\n");
  const docker = [
    "Types: deb",
    "URIs: https://download.docker.com/linux/ubuntu",
    "Suites: noble",
    "Components: stable",
    "Signed-By: /etc/apt/keyrings/docker.asc",
    "",
  ].join("\n");
  // Deb822 lets a field's values continue on indented lines, starting on the
  // line after an empty "URIs:". Canonical URIs collapse into one mirror entry.
  const continued = (uris) =>
    [
      "Types: deb deb-src",
      "URIs:",
      ...uris,
      "Suites: noble-proposed",
      "Components: main",
      `Signed-By: ${ubuntuKeyring}`,
    ].join("\n");
  const dir = fixture(t, {
    "etc/apt/sources.list.d/ubuntu.sources": `${stanza(
      "http://azure.archive.ubuntu.com/ubuntu/",
      "noble noble-updates noble-backports",
    )}\n\n${stanza(
      "http://security.ubuntu.com/ubuntu/",
      "noble-security",
    )}\n\n${continued([
      "  http://archive.ubuntu.com/ubuntu/",
      "\thttps://mirror.example.net/ubuntu/ http://security.ubuntu.com/ubuntu",
      "  http://azure.archive.ubuntu.com/ubuntu/",
    ])}\n`,
    "etc/apt/sources.list.d/docker.sources": docker,
  });

  const files = prefer(dir, "X64");

  assert.deepEqual(mirrors(files), x64Mirrors);
  assert.equal(
    files["etc/apt/sources.list.d/ubuntu.sources"],
    `${stanza(mirrorSource, "noble noble-updates noble-backports")}\n\n${stanza(
      mirrorSource,
      "noble-security",
    )}\n\n${continued([
      `  ${mirrorSource}`,
      "\thttps://mirror.example.net/ubuntu/",
    ])}\n`,
  );
  assert.equal(files["etc/apt/sources.list.d/docker.sources"], docker);
  assert.deepEqual(prefer(dir, "X64"), files, "second run changes nothing");
});

test("ARM64 legacy ports sources gain the independent ports replica", (t) => {
  const comment =
    "# deb-src http://ports.ubuntu.com/ubuntu-ports/ jammy main restricted";
  const dir = fixture(t, {
    "etc/apt/sources.list": [
      "deb http://ports.ubuntu.com/ubuntu-ports/ jammy main restricted",
      comment,
      `deb [arch=arm64 signed-by=${ubuntuKeyring}] http://ports.ubuntu.com/ubuntu-ports/ jammy-security main restricted`,
      "",
    ].join("\n"),
  });

  const files = prefer(dir, "ARM64");

  assert.deepEqual(mirrors(files), arm64Mirrors);
  assert.equal(
    files["etc/apt/sources.list"],
    [
      `deb ${mirrorSource} jammy main restricted`,
      comment,
      `deb [arch=arm64 signed-by=${ubuntuKeyring}] ${mirrorSource} jammy-security main restricted`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(prefer(dir, "ARM64"), files, "second run changes nothing");
});

test("APT acquisition retries and timeouts are bounded", (t) => {
  const dir = fixture(t, {
    "etc/apt/sources.list": "deb http://archive.ubuntu.com/ubuntu jammy main\n",
  });

  const files = prefer(dir, "X64");

  const settings = Object.entries(files)
    .filter(([path]) => path.startsWith("etc/apt/apt.conf.d/"))
    .flatMap(([, content]) => [
      ...content.matchAll(/^\s*(Acquire::[\w:]+)\s+"(\d+)";/gm),
    ])
    .map(([, key, value]) => [key, Number(value)]);
  const config = Object.fromEntries(settings);
  assert.ok(config["Acquire::Retries"] <= 3, "retries are bounded");
  for (const key of ["Acquire::http::Timeout", "Acquire::https::Timeout"])
    assert.ok(config[key] > 0 && config[key] <= 60, key);
});
