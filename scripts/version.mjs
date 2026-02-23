#!/usr/bin/env node

/**
 * Custom version script for the release workflow.
 *
 * 1) Runs standard Changesets versioning for workspace packages
 * 2) Independently bumps Python SDK version when a changeset includes
 *    "@veto/python-release"
 * 3) Prepends a Python changelog entry for those changesets
 *
 * This decouples Python SDK versioning from JavaScript SDK version numbers.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CHANGESET_DIR = resolve(".changeset");
const PYTHON_RELEASE_PACKAGE = "@veto/python-release";
const PYPROJECT_PATH = resolve("packages/sdk-python/pyproject.toml");
const PYTHON_CHANGELOG_PATH = resolve("packages/sdk-python/CHANGELOG.md");

const BUMP_PRIORITY = {
  patch: 0,
  minor: 1,
  major: 2,
};

function listChangesetFiles() {
  return readdirSync(CHANGESET_DIR)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => resolve(CHANGESET_DIR, file));
}

function parseChangeset(filePath) {
  const raw = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { releases: [], summary: "", path: filePath };
  }

  const [, frontmatter, body = ""] = match;
  const releases = [];

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    const releaseMatch = trimmed.match(
      /^["']?([^"']+)["']?:\s*(major|minor|patch)\s*$/
    );
    if (releaseMatch) {
      releases.push({ name: releaseMatch[1], type: releaseMatch[2] });
    }
  }

  return {
    releases,
    summary: body.trim(),
    path: filePath,
  };
}

function highestBump(types) {
  if (types.length === 0) {
    return null;
  }

  let best = "patch";
  for (const type of types) {
    if (BUMP_PRIORITY[type] > BUMP_PRIORITY[best]) {
      best = type;
    }
  }

  return best;
}

function bumpSemver(version, bumpType) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid Python version format: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (bumpType === "major") {
    return `${major + 1}.0.0`;
  }
  if (bumpType === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function updatePythonVersion(newVersion) {
  const pyproject = readFileSync(PYPROJECT_PATH, "utf8");
  const match = pyproject.match(/version = "([^"]+)"/);

  if (!match) {
    throw new Error(
      "Could not find version in packages/sdk-python/pyproject.toml"
    );
  }

  const currentVersion = match[1];
  if (currentVersion === newVersion) {
    console.log(`Python SDK already at ${newVersion}`);
    return;
  }

  const updated = pyproject.replace(
    `version = "${currentVersion}"`,
    `version = "${newVersion}"`
  );
  writeFileSync(PYPROJECT_PATH, updated);
  console.log(`Python SDK: ${currentVersion} -> ${newVersion}`);
}

function normalizeSummary(summary) {
  return summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function updatePythonChangelog(newVersion, bumpType, pythonEntries) {
  const changelog = readFileSync(PYTHON_CHANGELOG_PATH, "utf8");
  const heading = "# veto (Python SDK)\n\n";

  if (changelog.includes(`## ${newVersion}\n`)) {
    console.log(`Python changelog already contains ${newVersion}`);
    return;
  }

  const bullets = pythonEntries
    .map(({ summary }) => normalizeSummary(summary))
    .filter(Boolean)
    .map((summary) => `- ${summary}`)
    .join("\n");

  const entry =
    `## ${newVersion}\n\n` +
    `### ${capitalize(bumpType)} Changes\n\n` +
    `${bullets || "- Internal Python SDK release changes."}\n\n`;

  if (changelog.startsWith(heading)) {
    const updated = `${heading}${entry}${changelog.slice(heading.length)}`;
    writeFileSync(PYTHON_CHANGELOG_PATH, updated);
    return;
  }

  writeFileSync(PYTHON_CHANGELOG_PATH, `${entry}${changelog}`);
}

function main() {
  const pendingChangesets = listChangesetFiles().map(parseChangeset);
  const pythonEntries = pendingChangesets.filter(({ releases }) =>
    releases.some((release) => release.name === PYTHON_RELEASE_PACKAGE)
  );
  const pythonBump = highestBump(
    pythonEntries
      .flatMap(({ releases }) => releases)
      .filter((release) => release.name === PYTHON_RELEASE_PACKAGE)
      .map((release) => release.type)
  );

  execSync("pnpm changeset version", { stdio: "inherit" });

  if (!pythonBump) {
    console.log("No Python release marker changesets found.");
    return;
  }

  const pyproject = readFileSync(PYPROJECT_PATH, "utf8");
  const currentVersionMatch = pyproject.match(/version = "([^"]+)"/);
  if (!currentVersionMatch) {
    throw new Error("Could not find Python SDK version in pyproject.toml");
  }

  const currentVersion = currentVersionMatch[1];
  const newVersion = bumpSemver(currentVersion, pythonBump);

  updatePythonVersion(newVersion);
  updatePythonChangelog(newVersion, pythonBump, pythonEntries);
  console.log(
    `Applied Python release marker (${pythonBump}) from ${pythonEntries.length} changeset(s).`
  );
}

main();
