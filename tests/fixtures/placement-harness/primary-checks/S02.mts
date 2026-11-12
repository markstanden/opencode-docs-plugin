#!/usr/bin/env node
// Pristine primary check for S02: the staging deploy keeps every step and runs
// the smoke check after the switch and before the old slot is drained.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireFiles } from "./_replication-shared.mts";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: S02.mts <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "deploy/staging.json",
    "scripts/smoke.mjs",
]);

interface DeployStep {
    name: string;
    run: string;
}

interface Deploy {
    steps: DeployStep[];
}

/** Parse one staging deploy document, refusing a shape the check cannot read. */
function deployOf(path: string): Deploy {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null) {
        console.error(`${path}: deploy must be a JSON object`);
        process.exit(2);
    }
    const steps = (value as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) {
        console.error(`${path}: deploy.steps must be an array`);
        process.exit(2);
    }
    for (const step of steps) {
        if (typeof step !== "object" || step === null) {
            console.error(`${path}: each step must be an object`);
            process.exit(2);
        }
        const { name, run } = step as { name?: unknown; run?: unknown };
        if (typeof name !== "string" || typeof run !== "string") {
            console.error(`${path}: each step needs a string name and run`);
            process.exit(2);
        }
    }
    return { steps: steps as DeployStep[] };
}

const live = deployOf(join(liveWork, "deploy/staging.json"));
const pristine = deployOf(join(pristineWork, "deploy/staging.json"));
const names = live.steps.map((step) => step.name);
const problems: string[] = [];

for (const step of pristine.steps) {
    const found = live.steps.find((entry) => entry.name === step.name);
    if (found === undefined) problems.push(`missing step ${step.name}`);
    else if (found.run !== step.run)
        problems.push(`step ${step.name} changed its command`);
}
if (!names.includes("smoke")) problems.push("missing step smoke");
const at = (name: string): number => names.indexOf(name);
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
