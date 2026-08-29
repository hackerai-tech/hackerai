#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "https://github.com/usestrix/strix.git";
const DEFAULT_REF = "main";
const INTERNAL_CATEGORIES = new Set(["analysis", "coordination", "scan_modes"]);
const EXCLUDED_CATEGORIES = new Set(["tooling"]);
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_TOTAL_SKILL_BYTES = 2 * 1024 * 1024;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(repositoryRoot, "third_party", "strix-skills");
const vendorSkillsRoot = join(vendorRoot, "skills");
const manifestPath = join(vendorRoot, "UPSTREAM.json");
const generatedCatalogPath = join(
  repositoryRoot,
  "lib",
  "ai",
  "subagents",
  "skills",
  "strix-skill-catalog.generated.json",
);
const generatedContentPath = join(
  repositoryRoot,
  "lib",
  "ai",
  "subagents",
  "skills",
  "strix-skill-content.generated.json",
);

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const sourceArgIndex = args.indexOf("--source");
const sourceArg = sourceArgIndex >= 0 ? args[sourceArgIndex + 1] : undefined;
if (sourceArgIndex >= 0 && !sourceArg) {
  throw new Error("--source requires a repository path");
}

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const run = (command, commandArgs, cwd) => {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
};

const toPosix = (path) => path.split(sep).join("/");

const listMarkdownFiles = async (root) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Strix skill source contains a symlink: ${absolute}`);
      }
      if (entry.isDirectory()) {
        const sourcePath = toPosix(relative(root, absolute));
        if (EXCLUDED_CATEGORIES.has(sourcePath)) continue;
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(absolute);
      }
    }
  };
  await visit(root);
  return files.sort();
};

const unquote = (value) => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // YAML permits strings that are not valid JSON. Removing the matching
        // quotes is sufficient for Strix's simple name/description metadata.
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseSkill = (content, sourcePath) => {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`Missing YAML frontmatter: ${sourcePath}`);
  }
  const boundary = normalized.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error(`Unterminated YAML frontmatter: ${sourcePath}`);
  }
  const metadata = {};
  for (const line of normalized.slice(4, boundary).split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) metadata[match[1]] = unquote(match[2]);
  }
  if (!metadata.name || !metadata.description) {
    throw new Error(`Skill needs name and description metadata: ${sourcePath}`);
  }
  return {
    name: metadata.name,
    description: metadata.description,
    content: normalized.slice(boundary + "\n---\n".length).trim(),
  };
};

const buildArtifacts = async ({ skillsRoot, sourceCommit }) => {
  const markdownFiles = await listMarkdownFiles(skillsRoot);
  const fileHashes = {};
  const skills = [];
  let totalBytes = 0;

  for (const absolute of markdownFiles) {
    const sourcePath = toPosix(relative(skillsRoot, absolute));
    const content = await readFile(absolute);
    fileHashes[sourcePath] = sha256(content);
    totalBytes += content.byteLength;
    if (content.byteLength > MAX_SKILL_BYTES) {
      throw new Error(
        `Strix skill exceeds ${MAX_SKILL_BYTES} bytes: ${sourcePath}`,
      );
    }

    const parts = sourcePath.split("/");
    if (parts.length !== 2 || basename(sourcePath) === "README.md") continue;
    const category = parts[0];
    const filename = parts[1].replace(/\.md$/, "");
    const parsed = parseSkill(content.toString("utf8"), sourcePath);
    skills.push({
      id: `${category}/${filename}`,
      category,
      filename,
      name: parsed.name,
      description: parsed.description,
      contentBytes: Buffer.byteLength(parsed.content, "utf8"),
      internal: INTERNAL_CATEGORIES.has(category),
      sourcePath,
      sourceSha256: fileHashes[sourcePath],
      content: parsed.content,
    });
  }

  if (totalBytes > MAX_TOTAL_SKILL_BYTES) {
    throw new Error(
      `Strix skills exceed the ${MAX_TOTAL_SKILL_BYTES}-byte aggregate limit`,
    );
  }

  skills.sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set();
  for (const skill of skills) {
    if (ids.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
    ids.add(skill.id);
  }

  return {
    manifest: {
      sourceRepository: REPOSITORY,
      sourceCommit,
      license: "Apache-2.0",
      markdownFileCount: markdownFiles.length,
      selectableSkillCount: skills.filter((skill) => !skill.internal).length,
      internalSkillCount: skills.filter((skill) => skill.internal).length,
      files: fileHashes,
    },
    generatedCatalog: {
      sourceRepository: REPOSITORY,
      sourceCommit,
      skills: skills.map(({ content: _content, ...skill }) => skill),
    },
    generatedContent: {
      sourceRepository: REPOSITORY,
      sourceCommit,
      contents: Object.fromEntries(
        skills.map((skill) => [skill.id, skill.content]),
      ),
    },
  };
};

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const findMatchingVendoredSourceCommit = async (artifacts) => {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const sourceCommit = manifest.sourceCommit;
    if (typeof sourceCommit !== "string" || sourceCommit.length === 0) {
      return undefined;
    }

    const expected = {
      manifest: { ...artifacts.manifest, sourceCommit },
      generatedCatalog: { ...artifacts.generatedCatalog, sourceCommit },
      generatedContent: { ...artifacts.generatedContent, sourceCommit },
    };
    const vendored = await buildArtifacts({
      skillsRoot: vendorSkillsRoot,
      sourceCommit,
    });
    vendored.manifest.licenseSha256 = sha256(
      await readFile(join(vendorRoot, "LICENSE")),
    );

    if (stableJson(expected.manifest) !== stableJson(vendored.manifest)) {
      return undefined;
    }
    if (stableJson(expected.manifest) !== stableJson(manifest)) {
      return undefined;
    }
    if (
      stableJson(expected.generatedCatalog) !==
      (await readFile(generatedCatalogPath, "utf8"))
    ) {
      return undefined;
    }
    if (
      stableJson(expected.generatedContent) !==
      (await readFile(generatedContentPath, "utf8"))
    ) {
      return undefined;
    }

    return sourceCommit;
  } catch {
    return undefined;
  }
};

const checkArtifacts = async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expected = await buildArtifacts({
    skillsRoot: vendorSkillsRoot,
    sourceCommit: manifest.sourceCommit,
  });
  expected.manifest.licenseSha256 = sha256(
    await readFile(join(vendorRoot, "LICENSE")),
  );
  const actualGeneratedCatalog = await readFile(generatedCatalogPath, "utf8");
  const actualGeneratedContent = await readFile(generatedContentPath, "utf8");
  if (stableJson(expected.manifest) !== stableJson(manifest)) {
    throw new Error("Strix skill manifest is out of sync with vendored files");
  }
  if (stableJson(expected.generatedCatalog) !== actualGeneratedCatalog) {
    throw new Error("Generated Strix skill catalog is out of sync");
  }
  if (stableJson(expected.generatedContent) !== actualGeneratedContent) {
    throw new Error("Generated Strix skill content is out of sync");
  }
  await access(join(vendorRoot, "LICENSE"));
  console.log(
    `Verified ${manifest.selectableSkillCount} selectable Strix skills at ${manifest.sourceCommit}`,
  );
};

const updateArtifacts = async () => {
  let sourceRoot = sourceArg ? resolve(sourceArg) : undefined;
  let temporaryRoot;
  if (!sourceRoot) {
    temporaryRoot = await mkdtemp(join(tmpdir(), "hackerai-strix-skills-"));
    sourceRoot = join(temporaryRoot, "strix");
    run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      DEFAULT_REF,
      REPOSITORY,
      sourceRoot,
    ]);
  }

  try {
    const sourceSkillsRoot = join(sourceRoot, "strix", "skills");
    const sourceLicense = join(sourceRoot, "LICENSE");
    await access(sourceSkillsRoot);
    await access(sourceLicense);
    const sourceCommit = run("git", ["rev-parse", "HEAD"], sourceRoot);
    const artifacts = await buildArtifacts({
      skillsRoot: sourceSkillsRoot,
      sourceCommit,
    });
    artifacts.manifest.licenseSha256 = sha256(await readFile(sourceLicense));

    const matchingSourceCommit =
      await findMatchingVendoredSourceCommit(artifacts);
    if (matchingSourceCommit) {
      console.log(
        `No Strix skill changes at ${sourceCommit}; retaining ${matchingSourceCommit}`,
      );
      return;
    }

    await rm(vendorSkillsRoot, { recursive: true, force: true });
    await mkdir(vendorRoot, { recursive: true });
    await cp(sourceSkillsRoot, vendorSkillsRoot, {
      recursive: true,
      filter: (source) => {
        const statPath = toPosix(relative(sourceSkillsRoot, source));
        if (EXCLUDED_CATEGORIES.has(statPath.split("/")[0])) return false;
        return (
          statPath === "" ||
          source.endsWith(".md") ||
          !basename(source).includes(".")
        );
      },
    });
    await cp(sourceLicense, join(vendorRoot, "LICENSE"));
    await mkdir(dirname(generatedCatalogPath), { recursive: true });
    await writeFile(manifestPath, stableJson(artifacts.manifest));
    await writeFile(
      generatedCatalogPath,
      stableJson(artifacts.generatedCatalog),
    );
    await writeFile(
      generatedContentPath,
      stableJson(artifacts.generatedContent),
    );
    console.log(
      `Synced ${artifacts.manifest.selectableSkillCount} selectable Strix skills from ${sourceCommit}`,
    );
  } finally {
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
  }
};

if (checkOnly) {
  await checkArtifacts();
} else {
  await updateArtifacts();
}
