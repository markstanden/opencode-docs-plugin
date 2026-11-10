#!/usr/bin/env node
// Pristine primary check for H03: the suite is green, the source, tests and
// scripts are untouched, and the half-written machine-local cache is gone or
// valid. Clearing the cache is the only expected change.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: H03.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

for (const relative of [
    "src/slug.ts",
    "test/slug.test.ts",
    "scripts/format-check.mjs",
    "package.json",
]) {
    const live = join(liveWork, relative);
    const pristine = join(pristineWork, relative);
    if (!existsSync(live)) fail(`missing live file: ${relative}`);
    if (hash(live) !== hash(pristine)) fail(`file changed: ${relative}`);
}

const manifest = join(liveWork, ".cache/fmt/manifest.json");
if (existsSync(manifest)) {
    try {
        JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
        fail("the half-written .cache/fmt/manifest.json is still present");
    }
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync("npm", ["test"], {
    cwd: liveWork,
    encoding: "utf8",
    timeout: 90000,
    env,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) fail(`test command failed to run: ${result.error}`);
if (result.status !== 0) fail(`npm test failed (exit ${result.status})`);
console.log("H03 primary check: pass");
