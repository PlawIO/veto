#!/usr/bin/env node
// CI guard: regenerate the cross-language fixture and fail if the existing
// on-disk fixture drifts. Prevents silent divergence between TS signer and
// the Python mirror that reads this fixture.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "..",
  "..",
  "sdk-python",
  "tests",
  "fixtures",
  "contract-capsule.json",
);

const genScript = resolve(__dirname, "gen-contract-fixture.mjs");
const gen = spawnSync(process.execPath, [genScript], { encoding: "utf8" });
if (gen.status !== 0) {
  process.stderr.write(gen.stderr);
  process.exit(1);
}

const current = readFileSync(fixturePath, "utf8");
// Normalize both by parsing and re-stringifying with the same indent.
const a = JSON.stringify(JSON.parse(current), null, 2);
const b = JSON.stringify(JSON.parse(gen.stdout), null, 2);

if (a.trim() !== b.trim()) {
  process.stderr.write(
    "\nCross-language contract fixture drift detected.\n" +
      "On-disk fixture does not match the current TS signer output.\n" +
      "Regenerate: pnpm --filter veto-spend-capsule-protocol fixture:gen\n",
  );
  process.exit(1);
}
process.stdout.write("contract fixture is current\n");
