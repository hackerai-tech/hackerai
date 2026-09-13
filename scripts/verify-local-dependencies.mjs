#!/usr/bin/env node

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const projectRoot = resolve(process.cwd());
const packageJsonPath = join(projectRoot, "package.json");

const isInsideProject = (targetPath) => {
  const relativePath = relative(projectRoot, targetPath);

  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
};

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const requiredDependencyNames = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.devDependencies ?? {}),
]);
const dependencyNames = [
  ...new Set([
    ...requiredDependencyNames,
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ]),
].sort();

const missingDependencies = [];
const externalLinks = [];
const nodeModulesPath = join(projectRoot, "node_modules");

try {
  const nodeModulesStat = lstatSync(nodeModulesPath);

  if (nodeModulesStat.isSymbolicLink()) {
    const linkTarget = readlinkSync(nodeModulesPath);
    const resolvedTarget = resolve(dirname(nodeModulesPath), linkTarget);

    if (!isInsideProject(resolvedTarget)) {
      externalLinks.push({
        dependencyName: "node_modules",
        linkTarget: resolvedTarget,
      });
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}

for (const dependencyName of dependencyNames) {
  const dependencyPath = join(nodeModulesPath, dependencyName);

  let dependencyStat;
  try {
    dependencyStat = lstatSync(dependencyPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (requiredDependencyNames.has(dependencyName)) {
        missingDependencies.push(dependencyName);
      }
      continue;
    }

    throw error;
  }

  if (!dependencyStat.isSymbolicLink()) {
    continue;
  }

  const linkTarget = readlinkSync(dependencyPath);
  const resolvedTarget = resolve(dirname(dependencyPath), linkTarget);

  if (!isInsideProject(resolvedTarget)) {
    externalLinks.push({
      dependencyName,
      linkTarget: resolvedTarget,
    });
  }
}

if (externalLinks.length > 0) {
  console.error(
    [
      "Local dependencies are linked outside this checkout:",
      ...externalLinks.map(
        ({ dependencyName, linkTarget }) =>
          `  - ${dependencyName} -> ${linkTarget}`,
      ),
      "",
      "Each checkout or worktree must own its node_modules links.",
      "Repair this checkout with:",
      "  corepack pnpm install --force --frozen-lockfile",
    ].join("\n"),
  );
  process.exit(1);
}

if (missingDependencies.length > 0) {
  console.error(
    [
      `Local dependencies are incomplete (${missingDependencies.length} missing).`,
      "Install them in this checkout with:",
      "  corepack pnpm install --frozen-lockfile",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("Local dependency links are scoped to this checkout.");
