const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scriptPath = path.resolve(".github/scripts/prepare-desktop-release.sh");

function writeArtifact(root, artifact, filename, contents = filename) {
  const directory = path.join(root, artifact, "bundle");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, filename), contents);
}

function signatureFor(contents) {
  const digest = createHash("sha256").update(contents).digest("hex");
  return Buffer.from(`sha256:${digest}\n`).toString("base64");
}

function createArtifacts(root, version) {
  writeArtifact(root, "desktop-macOS-arm64", `HackerAI_${version}_aarch64.dmg`);
  writeArtifact(
    root,
    "desktop-macOS-arm64",
    "HackerAI.app.tar.gz",
    "mac-arm-updater",
  );
  writeArtifact(
    root,
    "desktop-macOS-arm64",
    "HackerAI.app.tar.gz.sig",
    signatureFor("mac-arm-updater"),
  );
  writeArtifact(root, "desktop-macOS-x64", `HackerAI_${version}_x64.dmg`);
  writeArtifact(
    root,
    "desktop-macOS-x64",
    "HackerAI.app.tar.gz",
    "mac-x64-updater",
  );
  writeArtifact(
    root,
    "desktop-macOS-x64",
    "HackerAI.app.tar.gz.sig",
    signatureFor("mac-x64-updater"),
  );
  writeArtifact(root, "desktop-macOS-universal", "HackerAI-universal.dmg");

  for (const filename of [
    `HackerAI_${version}_amd64.AppImage`,
    `HackerAI_${version}_amd64.AppImage.tar.gz`,
    `HackerAI_${version}_amd64.deb`,
  ]) {
    writeArtifact(root, "desktop-Linux-x64", filename);
  }
  const linuxX64Updater = `HackerAI_${version}_amd64.AppImage.tar.gz`;
  writeArtifact(
    root,
    "desktop-Linux-x64",
    `${linuxX64Updater}.sig`,
    signatureFor(linuxX64Updater),
  );

  for (const filename of [
    `HackerAI_${version}_aarch64.AppImage`,
    `HackerAI_${version}_aarch64.AppImage.tar.gz`,
    `HackerAI_${version}_arm64.deb`,
  ]) {
    writeArtifact(root, "desktop-Linux-arm64", filename);
  }
  const linuxArmUpdater = `HackerAI_${version}_aarch64.AppImage.tar.gz`;
  writeArtifact(
    root,
    "desktop-Linux-arm64",
    `${linuxArmUpdater}.sig`,
    signatureFor(linuxArmUpdater),
  );

  for (const filename of [
    `HackerAI_${version}_x64-setup.exe`,
    `HackerAI_${version}_x64-setup.nsis.zip`,
  ]) {
    writeArtifact(root, "desktop-Windows-x64", filename);
  }
  const windowsUpdater = `HackerAI_${version}_x64-setup.nsis.zip`;
  writeArtifact(
    root,
    "desktop-Windows-x64",
    `${windowsUpdater}.sig`,
    signatureFor(windowsUpdater),
  );
}

function runPreparation({
  artifactVersion = "0.0.57",
  mutateArtifacts,
  version = "0.0.57",
} = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "desktop-release-"));
  const artifacts = path.join(workspace, "artifacts");
  const release = path.join(workspace, "release");
  const binDirectory = path.join(workspace, "bin");
  createArtifacts(artifacts, artifactVersion);
  mutateArtifacts?.(artifacts);

  mkdirSync(binDirectory);
  writeFileSync(
    path.join(binDirectory, "minisign"),
    `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  case "$1" in
    -Vm) archive="$2"; shift 2 ;;
    -x) signature="$2"; shift 2 ;;
    -P) public_key="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ "$public_key" == "test-public-key" ]]
expected="$(sed -n 's/^sha256://p' "$signature")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
fi
[[ -n "$expected" && "$expected" == "$actual" ]]
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "bash",
    [
      scriptPath,
      artifacts,
      release,
      version,
      `desktop-v${version}`,
      "hackerai-tech/hackerai",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MINISIGN_PUBLIC_KEY: "test-public-key",
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        PUBLISH_DATE: "2026-07-17T00:00:00Z",
      },
    },
  );

  return { artifacts, release, result, workspace };
}

describe("prepare-desktop-release", () => {
  test("prepares fixed aliases and architecture-specific updater entries", () => {
    const fixture = runPreparation();

    try {
      expect(fixture.result.status).toBe(0);
      expect(fixture.result.stderr).toBe("");
      expect(
        existsSync(path.join(fixture.release, "HackerAI-linux-x64.AppImage")),
      ).toBe(true);
      expect(
        existsSync(path.join(fixture.release, "HackerAI-windows-x64.exe")),
      ).toBe(true);

      const latest = JSON.parse(
        readFileSync(path.join(fixture.release, "latest.json"), "utf8"),
      );
      expect(latest.version).toBe("0.0.57");
      expect(latest.pub_date).toBe("2026-07-17T00:00:00Z");
      expect(latest.platforms["darwin-aarch64"]).toEqual({
        url: "https://github.com/hackerai-tech/hackerai/releases/download/desktop-v0.0.57/HackerAI-aarch64.app.tar.gz",
        signature: signatureFor("mac-arm-updater"),
      });
      expect(latest.platforms["darwin-x86_64"]).toEqual({
        url: "https://github.com/hackerai-tech/hackerai/releases/download/desktop-v0.0.57/HackerAI-x86_64.app.tar.gz",
        signature: signatureFor("mac-x64-updater"),
      });
      expect(latest.platforms["windows-x86_64"].signature).toBe(
        signatureFor("HackerAI_0.0.57_x64-setup.nsis.zip"),
      );
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  });

  test("rejects artifacts whose embedded filename version does not match", () => {
    const fixture = runPreparation({ artifactVersion: "0.0.0" });

    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "Expected exactly one HackerAI_0.0.57_aarch64.dmg",
      );
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  });

  test("rejects an updater archive that does not match its signature", () => {
    const fixture = runPreparation({
      mutateArtifacts(artifacts) {
        writeArtifact(
          artifacts,
          "desktop-macOS-arm64",
          "HackerAI.app.tar.gz",
          "tampered-updater",
        );
      },
    });

    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "Updater signature verification failed: ",
      );
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  });

  test("rejects versions with leading-zero components", () => {
    const fixture = runPreparation({
      artifactVersion: "01.0.57",
      version: "01.0.57",
    });

    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "Invalid desktop version: 01.0.57",
      );
    } finally {
      rmSync(fixture.workspace, { recursive: true, force: true });
    }
  });
});
