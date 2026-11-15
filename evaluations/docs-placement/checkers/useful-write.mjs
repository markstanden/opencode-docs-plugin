#!/usr/bin/env node
// Product primary check for the useful-write case.
//
// OTC runs this in its own no-network container:
//   node /checker/useful-write.mjs /live /pristine
// `/live` is the completed trial workspace, `/pristine` the seeded one. Exit 0
// means the practical outcome holds; any non-zero exit is a task failure.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [live] = process.argv.slice(2);
if (live === undefined) {
    console.error("missing live workspace argument");
    process.exit(2);
}

const target = join(live, "docs", "notes", "otel.md");
if (!existsSync(target)) {
    console.error(`the expected note ${target} was not created`);
    process.exit(3);
}

const body = readFileSync(target, "utf8");
if (!body.includes("OpenTelemetry")) {
    console.error("the note does not retain the OpenTelemetry convention");
    process.exit(3);
}

process.exit(0);
