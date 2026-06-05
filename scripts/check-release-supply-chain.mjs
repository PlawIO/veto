#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const PACKAGE_DIR = "packages";
const BANNED_INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall"]);
const EXPECTED_REPOSITORY = "https://github.com/PlawIO/veto";

const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function listWorkspacePackageJsons() {
  const packagesRoot = join(ROOT, PACKAGE_DIR);
  const workspacePackages = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGE_DIR, entry.name, "package.json"))
    .filter((path) => existsSync(join(ROOT, path)))
    .sort();

  return ["package.json", ...workspacePackages];
}

function checkReleaseWorkflow() {
  const workflow = readText(RELEASE_WORKFLOW);
  const forbiddenPatterns = [
    [/\bNPM_TOKEN\b/, "npm publish token"],
    [/\bNODE_AUTH_TOKEN\b/, "npm auth token env"],
    [/\bPYPI_TOKEN\b/, "PyPI API token"],
    [/\bTWINE_[A-Z_]+\b/, "twine credential env"],
    [/\btwine\s+upload\b/, "twine token upload"],
    [/secrets\.VETO_PAT\b/, "long-lived GitHub PAT"],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(workflow)) {
      fail(`${RELEASE_WORKFLOW}: remove ${label}; release publishing must use OIDC.`);
    }
  }

  const requiredPatterns = [
    [/runs-on:\s*ubuntu-latest/g, "GitHub-hosted release runners"],
    [/node-version:\s*24/g, "Node 24 for npm trusted publishing"],
    [/id-token:\s*write/g, "OIDC id-token permission"],
    [/NPM_CONFIG_PROVENANCE:\s*"true"/g, "npm provenance config"],
    [/pypa\/gh-action-pypi-publish@release\/v1/g, "PyPI trusted publishing action"],
    [/github\.ref == 'refs\/heads\/master'/g, "protected master ref guard"],
  ];

  for (const [pattern, label] of requiredPatterns) {
    if (!pattern.test(workflow)) {
      fail(`${RELEASE_WORKFLOW}: missing ${label}.`);
    }
  }

  if (/runs-on:\s*blacksmith-/g.test(workflow)) {
    fail(`${RELEASE_WORKFLOW}: release publishing must not run on non-GitHub-hosted runners.`);
  }
}

function checkPackageManifest(path) {
  const manifest = readJson(path);
  const scripts = manifest.scripts ?? {};

  for (const hook of BANNED_INSTALL_HOOKS) {
    if (Object.hasOwn(scripts, hook)) {
      fail(`${path}: remove install-time script "${hook}".`);
    }
  }

  if (manifest.publishConfig?.provenance === false) {
    fail(`${path}: publishConfig.provenance must not be false.`);
  }

  if (manifest.private === true) {
    return;
  }

  const repository = manifest.repository;
  if (!repository || repository.url !== EXPECTED_REPOSITORY) {
    fail(`${path}: public workspace packages must declare repository.url=${EXPECTED_REPOSITORY}.`);
  }

  if (!repository?.directory) {
    fail(`${path}: public workspace packages must declare repository.directory.`);
  }

  if (manifest.publishConfig?.provenance !== true) {
    fail(`${path}: public workspace packages must set publishConfig.provenance=true.`);
  }
}

function main() {
  checkReleaseWorkflow();

  for (const path of listWorkspacePackageJsons()) {
    checkPackageManifest(path);
  }

  if (failures.length > 0) {
    console.error("Release supply-chain checks failed:");
    for (const message of failures) {
      console.error(`- ${message}`);
    }
    process.exit(1);
  }

  const packageCount = listWorkspacePackageJsons().length;
  console.log(
    `Release supply-chain checks passed for ${relative(ROOT, join(ROOT, RELEASE_WORKFLOW))} and ${packageCount} package manifests.`
  );
}

main();
