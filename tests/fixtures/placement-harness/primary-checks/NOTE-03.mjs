#!/usr/bin/env node
// Pristine primary check for NOTE-03: the stale session lock is gone, the
// source and tests are byte-identical to their seed, and the suite is green.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: NOTE-03.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

if (existsSync(join(liveWork, ".tmp/run.lock"))) {
    fail("the stale .tmp/run.lock is still present");
}

const hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
for (const relative of ["src/sum.ts", "test/sum.test.ts"]) {
    const live = join(liveWork, relative);
    const pristine = join(pristineWork, relative);
    if (!existsSync(live)) fail(`missing live file: ${relative}`);
    if (hash(live) !== hash(pristine)) {
        fail(`source or test changed: ${relative}`);
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
console.log("NOTE-03 primary check: pass");
