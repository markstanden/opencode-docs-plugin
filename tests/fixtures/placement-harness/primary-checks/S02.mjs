#!/usr/bin/env node
// Pristine primary check for S02: the staging deploy keeps every step and runs
// the smoke check after the switch and before the old slot is drained.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireFiles } from "./_replication-shared.mjs";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: S02.mjs <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "deploy/staging.json",
    "scripts/smoke.mjs",
]);

const live = JSON.parse(
    readFileSync(join(liveWork, "deploy/staging.json"), "utf8"),
);
const pristine = JSON.parse(
    readFileSync(join(pristineWork, "deploy/staging.json"), "utf8"),
);
const names = live.steps.map((step) => step.name);
const problems = [];

for (const step of pristine.steps) {
    const found = live.steps.find((entry) => entry.name === step.name);
    if (found === undefined) problems.push(`missing step ${step.name}`);
    else if (found.run !== step.run)
        problems.push(`step ${step.name} changed its command`);
}
if (!names.includes("smoke")) problems.push("missing step smoke");
const at = (name) => names.indexOf(name);
if (at("backfill") > at("switch"))
    problems.push("backfill must run before the switch");
if (at("smoke") < at("switch"))
    problems.push("smoke must run after the switch");
if (at("smoke") > at("drain"))
    problems.push("smoke must run before the old slot is drained");

if (problems.length > 0) {
    console.error(`S02 primary check: fail\n${problems.join("\n")}`);
    process.exit(1);
}
console.log("S02 primary check: pass");
