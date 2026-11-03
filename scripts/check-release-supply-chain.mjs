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
    [/\bPYPI_TOKEN\b/, "PyPI API token"],
    [/\bTWINE_[A-Z_]+\b/, "twine credential env"],
    [/\btwine\s+upload\b/, "twine token upload"],
    [/secrets\.VETO_PAT\b/, "long-lived GitHub PAT"],
    [/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*:/, "npm token environment variable"],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(workflow)) {
      fail(`${RELEASE_WORKFLOW}: remove ${label}; release publishing must use OIDC.`);
    }
  }

  checkReleaseRunners(workflow);

  const requiredPatterns = [
    [/node-version:\s*24/g, "Node 24 for npm trusted publishing"],
    [/id-token:\s*write/g, "OIDC id-token permission"],
    [/NPM_CONFIG_PROVENANCE:\s*"true"/g, "npm provenance config"],
    [/pypa\/gh-action-pypi-publish@release\/v1/g, "PyPI trusted publishing action"],
    [/github\.ref == 'refs\/heads\/master'/g, "protected master ref guard"],
    [/smoke:release-artifacts/g, "package smoke installs before release publish"],
  ];

  for (const [pattern, label] of requiredPatterns) {
    if (!pattern.test(workflow)) {
      fail(`${RELEASE_WORKFLOW}: missing ${label}.`);
    }
  }
}

const PUBLISHING_JOBS = {
  release: "ubuntu-24.04",
  "release-manual": "ubuntu-24.04",
};

function checkReleaseRunners(workflow) {
  const runners = parseJobRunners(workflow);

  for (const [job, expected] of Object.entries(PUBLISHING_JOBS)) {
    if (runners[job] !== expected) {
      fail(
        `${RELEASE_WORKFLOW}: ${job} must run on ${expected} so npm provenance sees a GitHub-hosted runner.`
      );
    }
  }

  for (const [job, label] of Object.entries(runners)) {
    if (Object.hasOwn(PUBLISHING_JOBS, job)) {
      continue;
    }
    if (!label.startsWith("depot-")) {
      fail(`${RELEASE_WORKFLOW}: ${job} must run on a depot-* runner.`);
    }
  }
}

function parseJobRunners(workflow) {
  const runners = {};
  let inJobs = false;
  let currentJob = null;

  for (const line of workflow.split("\n")) {
    if (/^jobs:\s*(?:#.*)?$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }

    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      continue;
    }

    const runsMatch = /^    runs-on:[ \t]*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!runsMatch || !currentJob) {
      continue;
    }

    runners[currentJob] = runsMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  return runners;
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

  // npm 11 publish removes bin entries with a leading ./ instead of normalizing them.
  const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) {
    if (bin.startsWith("./")) {
      fail(`${path}: bin path ${bin} must omit the leading ./ for npm 11 publishing.`);
    }
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
  const rootManifest = readJson("package.json");
  if (rootManifest.scripts?.["smoke:release-artifacts"] !== "node scripts/smoke-release-artifacts.mjs") {
    fail("package.json: missing smoke:release-artifacts script.");
  }

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
