#!/usr/bin/env node
// Pristine primary check for NOTE-04: the replay fixture, check script and
// webhook test are byte-identical to their seed, and the webhook tests pass.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: NOTE-04.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
for (const relative of [
    "test/fixtures/replay.json",
    "scripts/webhook-check.mjs",
    "test/webhook.test.ts",
]) {
    const live = join(liveWork, relative);
    const pristine = join(pristineWork, relative);
    if (!existsSync(live)) fail(`missing live file: ${relative}`);
    if (hash(live) !== hash(pristine)) {
        fail(`protected fixture changed: ${relative}`);
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
if (result.status !== 0) {
    fail(`npm test failed (exit ${result.status})`);
}
console.log("NOTE-04 primary check: pass");
