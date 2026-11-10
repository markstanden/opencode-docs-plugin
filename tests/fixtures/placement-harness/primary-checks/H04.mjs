#!/usr/bin/env node
// Pristine primary check for H04: the repository gate is green and nothing
// under legacy/ changed. The full lint run is expected to fail by design.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: H04.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

const walk = (root, dir) => {
    const files = [];
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const next = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walk(root, next));
        else files.push(next);
    }
    return files;
};

const liveLegacy = walk(liveWork, "legacy").sort();
const pristineLegacy = walk(pristineWork, "legacy").sort();
if (liveLegacy.join("\n") !== pristineLegacy.join("\n")) {
    fail("the set of files under legacy/ changed");
}
for (const path of pristineLegacy) {
    if (!existsSync(join(liveWork, path))) {
        fail(`legacy file removed: ${relative("", path)}`);
    }
    if (hash(join(liveWork, path)) !== hash(join(pristineWork, path))) {
        fail(`legacy file changed: ${path}`);
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
console.log("H04 primary check: pass");
